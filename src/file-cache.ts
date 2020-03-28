/*
 * Copyright 2019 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may
 not
 * use this file except in compliance with the License. You may obtain a copy
 of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 under
 * the License.
 */

'use strict';

import * as Koa from 'koa';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

type CacheEntry = {
  saved: Date,
  headers: { [key: string]: string },
  fileId: string,
  url: string
};

export const CACHE_MAX_ENTRIES = 1000;
export const FILE_CACHE_DIR = '../file-cache-data';
export const FILE_CACHE_TTL = 86400000;

// implements a cache that uses the "least-recently used" strategy to clear unused elements.
export class FileCache {
  private store: CacheEntry[] = this.getStore();

  // async clearCache() {
  // Needs to be implemented
  // }

  cacheContent(key: string, headers: { [key: string]: string }, payload: Buffer) {
    //remove refreshCache from URL
    let cacheKey = key
      .replace(/&?refreshCache=(?:true|false)&?/i, '');

    if (cacheKey.charAt(cacheKey.length - 1) === '?') {
      cacheKey = cacheKey.slice(0, -1);
    }

    const fileId: string = uuidv4();

    try {
      fs.writeFileSync(path.join(__dirname, FILE_CACHE_DIR, `${fileId}.html`), payload);
      // if the cache gets too big, we evict the least recently used entry
      if (this.store.length >= CACHE_MAX_ENTRIES) {
        this.store.shift();
      }
      this.store.push({
        saved: new Date(),
        headers: headers,
        fileId: fileId,
        url: cacheKey
      });
      fs.writeFileSync(path.join(__dirname, FILE_CACHE_DIR, 'index.json'), JSON.stringify(this.store, null, '  '));
    }
    catch (error) {
      console.log(error);
    }
  }

  getCachedContent(ctx: Koa.Context, key: string) {
    if (ctx.query.refreshCache) {
      return;
    }
    const entryIndex = this.store.findIndex(({ url }) => url === key);
    let entryValue = this.store[entryIndex];
    // we need to re-insert this key to mark it as "most recently read"
    if (entryValue) {
      this.store.splice(entryIndex, 1);
      const isEntryExpired: boolean = (new Date(entryValue.saved).getTime() + FILE_CACHE_TTL) < new Date().getTime();
      if (!isEntryExpired) {
        this.store.push(entryValue);
        try {
          fs.writeFileSync(path.join(__dirname, FILE_CACHE_DIR, 'index.json'), JSON.stringify(this.store, null, '  '));
        } catch (error) {
          console.log(error);
        }
      } else {
        return;
      }
    }
    return entryValue;
  }

  middleware() {
    return this.handleRequest.bind(this);
  }

  private getStore() {
    let store: CacheEntry[] = [];
    try {
      const indexFile = fs.readFileSync(path.join(__dirname, FILE_CACHE_DIR, 'index.json'), 'utf8');
      store = JSON.parse(indexFile);
    }
    catch (error) {
      if (error && error.code === 'ENOENT') {
        fs.mkdirSync(path.join(__dirname, FILE_CACHE_DIR), { recursive: true });
        fs.writeFileSync(path.join(__dirname, FILE_CACHE_DIR, 'index.json'), JSON.stringify([]));
      } else {
        throw (error);
      }
    }
    return store;
  }

  private async handleRequest(ctx: Koa.Context, next: () => Promise<unknown>) {
    // Cache based on full URL. This means requests with different params are
    // cached separately.
    const cacheKey = ctx.url;
    const cachedContent = this.getCachedContent(ctx, cacheKey);
    if (cachedContent) {
      ctx.set(cachedContent.headers);
      ctx.set('x-rendertron-cached', new Date(cachedContent.saved).toUTCString());
      try {
        const payload = fs.readFileSync(path.join(__dirname, FILE_CACHE_DIR, `${cachedContent.fileId}.html`), 'utf-8');
        ctx.body = payload;
        return;
      } catch (error) {
        console.log(
          'Erroring parsing cache contents, falling back to normal render');
      }
    }

    await next();

    if (ctx.status === 200) {
      this.cacheContent(cacheKey, ctx.response.headers, ctx.body);
    }
  }
}
