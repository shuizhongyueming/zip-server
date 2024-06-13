import {Entry} from '@zip.js/zip.js'
import {configure, ZipReader, BlobWriter, BlobReader} from '@zip.js/zip.js/lib/zip-no-worker-inflate.js'

interface Remote {
  name: string;
  zipUrl: string;
  prefix: string;
}

export interface ZipFileServerOptions {
  remotes: Remote[];
  fetch: typeof fetch;
  fallbackUrl: string;
}

export interface UrlResponse {
  url: string;
  onComplete: () => void;
}

export class ZipFileServer {
  static SuffixMapContentType = {
    FORM_URLENCODED: 'application/x-www-form-urlencoded',
    GIF: 'image/gif',
    JPEG: 'image/jpeg',
    DDS: 'image/dds',
    JSON: 'application/json',
    PNG: 'image/png',
    TEXT: 'text/plain',
    XML: 'application/xml',
    WAV: 'audio/x-wav',
    OGG: 'audio/ogg',
    MP3: 'audio/mpeg',
    MP4: 'audio/mp4',
    AAC: 'audio/aac',
    BIN: 'application/octet-stream',
    BASIS: 'image/basis',
    WASM: 'application/wasm',
    GLB: 'model/gltf-binary',
  };

  private remotes: Map<string, Remote>;
  private readonly fetch: typeof fetch;
  private zipCache = new Map<string, Promise<Entry[]>>();
  private readonly fallbackUrl: string;

  constructor(options: ZipFileServerOptions) {
    configure({ useWebWorkers: false });
    this.remotes = new Map(options.remotes.map((remote) => [remote.name, remote]));
    this.fetch = options.fetch;
    this.fallbackUrl = options.fallbackUrl.endsWith('/')
      ? options.fallbackUrl
      : `${options.fallbackUrl}/`;
  }

  async getData(filePath: string, init?: RequestInit): Promise<Response> {
    const headers = init?.headers || {};

    // only handle GET request with zip file
    if (init?.method && init?.method !== 'GET' && !this.isPathUrl(filePath)) {
      console.warn(`zip-file-server: not a GET request, so fallback to fetch: `, init.method, filePath);
      return this.fetch(filePath, init);
    }

    try {
      const blob = await this.getBlob(filePath, headers);
      if (blob) {
        return new Response(blob, {
          status: 200,
          statusText: 'OK',
          headers,
        });
      }
    } catch (e) {
      console.error('zip-file-server: getData: Failed to get blob from zip file: ', filePath, e);
    }

    console.warn('zip-file-server: getData fallback to fetch for file: ', filePath);
    return this.fetch(filePath, init);
  }

  async getUrl(filePath: string): Promise<UrlResponse> {
    if (!this.isPathUrl(filePath)) {
      return {
        url: filePath,
        onComplete: () => {},
      };
    }

    try {
      const blob = await this.getBlob(filePath);

      if (blob) {
        const url = URL.createObjectURL(blob);
        return {
          url,
          onComplete: () => {
            URL.revokeObjectURL(url);
          },
        };
      }
    } catch(e) {
      console.error('zip-file-server: getUrl: Failed to get blob from zip file: ', filePath, e);
    }

    console.warn('zip-file-server: getUrl fallback to getFallbackUrl: ', filePath);
    return {
      url: this.getFallbackUrl(filePath),
      onComplete: () => {},
    };
  }

  // Preload zip file based on name
  async preload(name: string): Promise<void> {
    const remote = this.remotes.get(name);
    if (!remote) {
      return console.error(`zip-file-server: Failed to preload zip file: ${name}, not found`);
    }
    await this.getZip(remote.zipUrl);
  }

  // unload zip file based on name to free memory
  async unload(name: string): Promise<void> {
    const remote = this.remotes.get(name);
    if (!remote) {
      return console.error(`zip-file-server: Failed to unload zip file: ${name}, not found`);
    }
    this.zipCache.delete(remote.zipUrl);
  }

  addRemote(remote: Remote) {
    if (this.remotes.has(remote.name)) {
      throw new Error(`zip-file-server: remote ${remote.name} already exists`);
    }
    this.remotes.set(remote.name, remote);
  }

  private isPathUrl(url: string) {
    return !url.startsWith('blob:') && !url.startsWith('data:');
  }

  private getFallbackUrl(filePath: string): string {
    filePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    if (this.fallbackUrl) {
      return `${this.fallbackUrl}${filePath}`;
    }
    return filePath;
  }

  private async getBlob(url: string, headers?: HeadersInit): Promise<Blob | null> {
    const entry = await this.getTargetEntry(url);

    if (entry) {
      let writer: BlobWriter;
      if (headers?.['content-type']) {
        writer = this.getWriterBasedOnContentType(headers['content-type']);
      } else {
        writer = this.getWriterBasedOnUrl(url);
      }
      return entry.getData!(writer);
    }
    return null;
  }

  private getWriterBasedOnUrl(url: string): BlobWriter {
    const mimeType = this.getMimeTypeFromUrl(url);
    return new BlobWriter(mimeType);
  }

  private getSuffixFromUrl(url: string): string {
    const suffix = url.split('?').pop()!.split('.').pop();
    return suffix ? suffix.toLowerCase() : '';
  }

  private getMimeTypeFromUrl(url: string): string {
    const suffix = this.getSuffixFromUrl(url).toUpperCase();
    return ZipFileServer.SuffixMapContentType[suffix] || 'application/octet-stream';
  }

  private getWriterBasedOnContentType(contentType: string): BlobWriter {
    const mimeType = contentType.split(';')[0];
    return new BlobWriter(mimeType);
  }

  private async getTargetEntry(url: string): Promise<Entry | null> {
    // 找到对应的 remote sources
    const remote = this.getRemote(url);
    if (!remote) {
      console.log('zip-file-server: getTargetEntry has no remote for url: ', url);
      return null;
    }
    // 从 remote sources 中找到对应的 zipUrl
    const zipUrl = remote.zipUrl;
    const pathInZip = url.slice(remote.prefix.length);
    // 基于 zipUrl 从缓存或者远程服务器获取 zip
    try {
      const entries = await this.getZip(zipUrl);
      return entries.find((entry) => entry.filename === pathInZip) || null;
    } catch (error) {
      console.error('zip-file-server: get entry failed: ', url, error);
      return null;
    }
  }

  private getRemote(url: string): Remote | null {
    for (const remote of this.remotes.values()) {
      if (url.startsWith(remote.prefix)) {
        return remote;
      }
    }
    return null;
  }

  private async fetchZip(baseUrl: string): Promise<Entry[]> {
    let response: Response;

    try {
      response = await this.fetch(baseUrl);
    } catch (error) {
      console.error('zip-file-server: getZip fetch zip error: ', baseUrl, error)
      throw new Error(`Failed to fetch zip from ${baseUrl}: ${error}`);
    }

    if (!response.ok) {
      console.error('zip-file-server: getZip fetch zip failed: ', baseUrl, response.status, response.statusText);
      throw new Error(
          `Failed to fetch zip from ${baseUrl}: ${response.status} ${response.statusText}`
      );
    }

    try {
      const blob = await response.blob();
      const reader = new ZipReader(new BlobReader(blob));
      const entries: Entry[] = await reader.getEntries();
      reader.close();
      return entries;
    } catch (e) {
      console.error('zip-file-server: getZip get entries failed: ', baseUrl, e)
      throw new Error(`Failed to get entries from zip: ${baseUrl}, ${e}`);
    }
  }

  private getZip(baseUrl: string): Promise<Entry[]> {
    if (!this.zipCache.has(baseUrl)) {
      console.log('zip-file-server: getZip, has no cache, request it', baseUrl)
      this.zipCache.set(baseUrl, this.fetchZip(baseUrl));
    }
    return this.zipCache.get(baseUrl)!;
  }
}
