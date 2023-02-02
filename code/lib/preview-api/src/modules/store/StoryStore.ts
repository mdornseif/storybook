import memoize from 'memoizerific';
import type {
  IndexEntry,
  Renderer,
  API_PreparedStoryIndex,
  ComponentTitle,
  Parameters,
  Path,
  ProjectAnnotations,
  BoundStory,
  CSFFile,
  ModuleExports,
  ModuleImportFn,
  NormalizedProjectAnnotations,
  PreparedStory,
  StoryIndex,
  StoryIndexV3,
  V2CompatIndexEntry,
  StoryContext,
  StoryContextForEnhancers,
  StoryContextForLoaders,
  StoryId,
} from '@storybook/types';
import { mapValues, pick } from 'lodash-es';
import { SynchronousPromise } from 'synchronous-promise';

import { HooksContext } from '../addons';
import { StoryIndexStore } from './StoryIndexStore';
import { ArgsStore } from './ArgsStore';
import { GlobalsStore } from './GlobalsStore';
import { processCSFFile, prepareStory, normalizeProjectAnnotations } from './csf';

const CSF_CACHE_SIZE = 1000;
const STORY_CACHE_SIZE = 10000;
const EXTRACT_BATCH_SIZE = 20;

export class StoryStore<TRenderer extends Renderer> {
  storyIndex?: StoryIndexStore;

  importFn?: ModuleImportFn;

  projectAnnotations?: NormalizedProjectAnnotations<TRenderer>;

  globals?: GlobalsStore;

  args: ArgsStore;

  hooks: Record<StoryId, HooksContext<TRenderer>>;

  cachedCSFFiles?: Record<Path, CSFFile<TRenderer>>;

  processCSFFileWithCache: typeof processCSFFile;

  prepareStoryWithCache: typeof prepareStory;

  initializationPromise: SynchronousPromise<void>;

  // This *does* get set in the constructor but the semantics of `new SynchronousPromise` trip up TS
  resolveInitializationPromise!: () => void;

  constructor() {
    this.args = new ArgsStore();
    this.hooks = {};

    // We use a cache for these two functions for two reasons:
    //  1. For performance
    //  2. To ensure that when the same story is prepared with the same inputs you get the same output
    this.processCSFFileWithCache = memoize(CSF_CACHE_SIZE)(processCSFFile) as typeof processCSFFile;
    this.prepareStoryWithCache = memoize(STORY_CACHE_SIZE)(prepareStory) as typeof prepareStory;

    // We cannot call `loadStory()` until we've been initialized properly. But we can wait for it.
    this.initializationPromise = new SynchronousPromise((resolve) => {
      this.resolveInitializationPromise = resolve;
    });
  }

  setProjectAnnotations(projectAnnotations: ProjectAnnotations<TRenderer>) {
    // By changing `this.projectAnnotations, we implicitly invalidate the `prepareStoryWithCache`
    this.projectAnnotations = normalizeProjectAnnotations(projectAnnotations);
    const { globals, globalTypes } = projectAnnotations;

    if (this.globals) {
      this.globals.set({ globals, globalTypes });
    } else {
      this.globals = new GlobalsStore({ globals, globalTypes });
    }
  }

  initialize({
    storyIndex,
    importFn,
    cache = false,
  }: {
    storyIndex?: StoryIndex;
    importFn: ModuleImportFn;
    cache?: boolean;
  }): Promise<void> {
    this.storyIndex = new StoryIndexStore(storyIndex);
    this.importFn = importFn;

    // We don't need the cache to be loaded to call `loadStory`, we just need the index ready
    this.resolveInitializationPromise();

    return cache ? this.cacheAllCSFFiles() : SynchronousPromise.resolve();
  }

  // This means that one of the CSF files has changed.
  // If the `importFn` has changed, we will invalidate both caches.
  // If the `storyIndex` data has changed, we may or may not invalidate the caches, depending
  // on whether we've loaded the relevant files yet.
  async onStoriesChanged({
    importFn,
    storyIndex,
  }: {
    importFn?: ModuleImportFn;
    storyIndex?: StoryIndex;
  }) {
    await this.initializationPromise;

    if (importFn) this.importFn = importFn;
    // The index will always be set before the initialization promise returns
    if (storyIndex) this.storyIndex!.entries = storyIndex.entries;
    if (this.cachedCSFFiles) await this.cacheAllCSFFiles();
  }

  // Get an entry from the index, waiting on initialization if necessary
  async storyIdToEntry(storyId: StoryId): Promise<IndexEntry> {
    await this.initializationPromise;
    // The index will always be set before the initialization promise returns
    return this.storyIndex!.storyIdToEntry(storyId);
  }

  // To load a single CSF file to service a story we need to look up the importPath in the index
  loadCSFFileByStoryId(storyId: StoryId): Promise<CSFFile<TRenderer>> {
    if (!this.storyIndex || !this.importFn)
      throw new Error(`loadCSFFileByStoryId called before initialization`);

    const { importPath, title } = this.storyIndex.storyIdToEntry(storyId);
    return this.importFn(importPath).then((moduleExports) =>
      // We pass the title in here as it may have been generated by autoTitle on the server.
      this.processCSFFileWithCache(moduleExports, importPath, title)
    );
  }

  loadAllCSFFiles({ batchSize = EXTRACT_BATCH_SIZE } = {}): Promise<
    StoryStore<TRenderer>['cachedCSFFiles']
  > {
    if (!this.storyIndex) throw new Error(`loadAllCSFFiles called before initialization`);

    const importPaths = Object.entries(this.storyIndex.entries).map(([storyId, { importPath }]) => [
      importPath,
      storyId,
    ]);

    const loadInBatches = (
      remainingImportPaths: typeof importPaths
    ): Promise<{ importPath: Path; csfFile: CSFFile<TRenderer> }[]> => {
      if (remainingImportPaths.length === 0) return SynchronousPromise.resolve([]);

      const csfFilePromiseList = remainingImportPaths
        .slice(0, batchSize)
        .map(([importPath, storyId]) =>
          this.loadCSFFileByStoryId(storyId).then((csfFile) => ({
            importPath,
            csfFile,
          }))
        );

      return SynchronousPromise.all(csfFilePromiseList).then((firstResults) =>
        loadInBatches(remainingImportPaths.slice(batchSize)).then((restResults) =>
          firstResults.concat(restResults)
        )
      );
    };

    return loadInBatches(importPaths).then((list) =>
      list.reduce((acc, { importPath, csfFile }) => {
        acc[importPath] = csfFile;
        return acc;
      }, {} as Record<Path, CSFFile<TRenderer>>)
    );
  }

  cacheAllCSFFiles(): Promise<void> {
    return this.initializationPromise.then(() =>
      this.loadAllCSFFiles().then((csfFiles) => {
        this.cachedCSFFiles = csfFiles;
      })
    );
  }

  // Load the CSF file for a story and prepare the story from it and the project annotations.
  async loadStory({ storyId }: { storyId: StoryId }): Promise<PreparedStory<TRenderer>> {
    await this.initializationPromise;
    const csfFile = await this.loadCSFFileByStoryId(storyId);
    return this.storyFromCSFFile({ storyId, csfFile });
  }

  // This function is synchronous for convenience -- often times if you have a CSF file already
  // it is easier not to have to await `loadStory`.
  storyFromCSFFile({
    storyId,
    csfFile,
  }: {
    storyId: StoryId;
    csfFile: CSFFile<TRenderer>;
  }): PreparedStory<TRenderer> {
    if (!this.projectAnnotations) throw new Error(`storyFromCSFFile called before initialization`);

    const storyAnnotations = csfFile.stories[storyId];
    if (!storyAnnotations) {
      throw new Error(`Didn't find '${storyId}' in CSF file, this is unexpected`);
    }
    const componentAnnotations = csfFile.meta;

    const story = this.prepareStoryWithCache(
      storyAnnotations,
      componentAnnotations,
      this.projectAnnotations
    );
    this.args.setInitial(story);
    this.hooks[story.id] = this.hooks[story.id] || new HooksContext();
    return story;
  }

  // If we have a CSF file we can get all the stories from it synchronously
  componentStoriesFromCSFFile({
    csfFile,
  }: {
    csfFile: CSFFile<TRenderer>;
  }): PreparedStory<TRenderer>[] {
    if (!this.storyIndex)
      throw new Error(`componentStoriesFromCSFFile called before initialization`);

    return Object.keys(this.storyIndex.entries)
      .filter((storyId: StoryId) => !!csfFile.stories[storyId])
      .map((storyId: StoryId) => this.storyFromCSFFile({ storyId, csfFile }));
  }

  async loadEntry(id: StoryId) {
    const entry = await this.storyIdToEntry(id);

    const { importFn, storyIndex } = this;
    if (!storyIndex || !importFn) throw new Error(`loadEntry called before initialization`);

    const storyImports = entry.type === 'docs' ? entry.storiesImports : [];

    const [entryExports, ...csfFiles] = (await Promise.all([
      importFn(entry.importPath),
      ...storyImports.map((storyImportPath) => {
        const firstStoryEntry = storyIndex.importPathToEntry(storyImportPath);
        return this.loadCSFFileByStoryId(firstStoryEntry.id);
      }),
    ])) as [ModuleExports, ...CSFFile<TRenderer>[]];

    return { entryExports, csfFiles };
  }

  // A prepared story does not include args, globals or hooks. These are stored in the story store
  // and updated separtely to the (immutable) story.
  getStoryContext(
    story: PreparedStory<TRenderer>
  ): Omit<StoryContextForLoaders<TRenderer>, 'viewMode'> {
    if (!this.globals) throw new Error(`getStoryContext called before initialization`);

    return {
      ...story,
      args: this.args.get(story.id),
      globals: this.globals.get(),
      hooks: this.hooks[story.id] as unknown,
    };
  }

  cleanupStory(story: PreparedStory<TRenderer>): void {
    this.hooks[story.id].clean();
  }

  extract(
    options: { includeDocsOnly?: boolean } = { includeDocsOnly: false }
  ): Record<StoryId, StoryContextForEnhancers<TRenderer>> {
    if (!this.storyIndex) throw new Error(`extract called before initialization`);

    const { cachedCSFFiles } = this;
    if (!cachedCSFFiles)
      throw new Error('Cannot call extract() unless you call cacheAllCSFFiles() first.');

    return Object.entries(this.storyIndex.entries).reduce(
      (acc, [storyId, { type, importPath }]) => {
        if (type === 'docs') return acc;

        const csfFile = cachedCSFFiles[importPath];
        const story = this.storyFromCSFFile({ storyId, csfFile });

        if (!options.includeDocsOnly && story.parameters.docsOnly) {
          return acc;
        }

        acc[storyId] = Object.entries(story).reduce(
          (storyAcc, [key, value]) => {
            if (key === 'moduleExport') return storyAcc;
            if (typeof value === 'function') {
              return storyAcc;
            }
            if (Array.isArray(value)) {
              return Object.assign(storyAcc, { [key]: value.slice().sort() });
            }
            return Object.assign(storyAcc, { [key]: value });
          },
          { args: story.initialArgs }
        );
        return acc;
      },
      {} as Record<string, any>
    );
  }

  getSetStoriesPayload() {
    if (!this.globals) throw new Error(`getSetStoriesPayload called before initialization`);

    const stories = this.extract({ includeDocsOnly: true });

    const kindParameters: Parameters = Object.values(stories).reduce(
      (acc: Parameters, { title }: { title: ComponentTitle }) => {
        acc[title] = {};
        return acc;
      },
      {} as Parameters
    );

    return {
      v: 2,
      globals: this.globals.get(),
      globalParameters: {},
      kindParameters,
      stories,
    };
  }

  // NOTE: this is legacy `stories.json` data for the `extract` script.
  // It is used to allow v7 Storybooks to be composed in v6 Storybooks, which expect a
  // `stories.json` file with legacy fields (`kind` etc).
  getStoriesJsonData = (): StoryIndexV3 => {
    const { storyIndex } = this;
    if (!storyIndex) throw new Error(`getStoriesJsonData called before initialization`);

    const value = this.getSetStoriesPayload();
    const allowedParameters = ['fileName', 'docsOnly', 'framework', '__id', '__isArgsStory'];

    const stories: Record<StoryId, V2CompatIndexEntry> = mapValues(value.stories, (story) => {
      const { importPath } = storyIndex.entries[story.id];
      return {
        ...pick(story, ['id', 'name', 'title']),
        importPath,
        // These 3 fields were going to be dropped in v7, but instead we will keep them for the
        // 7.x cycle so that v7 Storybooks can be composed successfully in v6 Storybook.
        // In v8 we will (likely) completely drop support for `extract` and `getStoriesJsonData`
        kind: story.title,
        story: story.name,
        parameters: {
          ...pick(story.parameters, allowedParameters),
          fileName: importPath,
        },
      };
    });

    return {
      v: 3,
      stories,
    };
  };

  getSetIndexPayload(): API_PreparedStoryIndex {
    if (!this.storyIndex) throw new Error('getSetIndexPayload called before initialization');

    const stories = this.extract({ includeDocsOnly: true });

    return {
      v: 4,
      entries: Object.fromEntries(
        Object.entries(this.storyIndex.entries).map(([id, entry]) => [
          id,
          stories[id]
            ? {
                ...entry,
                args: stories[id].initialArgs,
                initialArgs: stories[id].initialArgs,
                argTypes: stories[id].argTypes,
                parameters: stories[id].parameters,
              }
            : entry,
        ])
      ),
    };
  }

  raw(): BoundStory<TRenderer>[] {
    return Object.values(this.extract())
      .map(({ id }: { id: StoryId }) => this.fromId(id))
      .filter(Boolean) as BoundStory<TRenderer>[];
  }

  fromId(storyId: StoryId): BoundStory<TRenderer> | null {
    if (!this.storyIndex) throw new Error(`fromId called before initialization`);

    if (!this.cachedCSFFiles)
      throw new Error('Cannot call fromId/raw() unless you call cacheAllCSFFiles() first.');

    let importPath;
    try {
      ({ importPath } = this.storyIndex.storyIdToEntry(storyId));
    } catch (err) {
      return null;
    }
    const csfFile = this.cachedCSFFiles[importPath];
    const story = this.storyFromCSFFile({ storyId, csfFile });
    return {
      ...story,
      storyFn: (update) => {
        const context = {
          ...this.getStoryContext(story),
          viewMode: 'story',
        } as StoryContext<TRenderer>;

        return story.unboundStoryFn({ ...context, ...update });
      },
    };
  }
}
