/**
 * CanonRepository read adapter. Published HEAD is the execution-time truth;
 * the working Markdown store remains the human editing/import surface.
 */
export async function openCanonRepository({ store, publicationUnit }) {
  const published = await publicationUnit.readPublished();
  if (!published.ok) throw new Error(`CORRUPT_PUBLICATION: ${published.error.code}`);
  if (!published.value) return store;
  const { tree = {}, projections = {} } = published.value;
  const plans = tree.plans ?? {};
  const own = {
    async loadFoundation() { return tree.foundation ?? null; },
    async loadStoryState(_workId, chapter) {
      return Number(projections.storyState?.chapterNumber) === Number(chapter) ? structuredClone(projections.storyState) : null;
    },
    async loadEntitySnapshots() { return structuredClone(projections.entities ?? []); },
    async loadCharacterDynamics() { return structuredClone(projections.characterDynamics ?? null); },
    async listChapters() { return Object.keys(tree.chapters ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b); },
    async loadRecentChapterSummaries(_workId, beforeChapter, limit) {
      return Object.entries(tree.summaries ?? {}).map(([number, value]) => ({
        chapterNumber: Number(number), ...(value && typeof value === 'object' ? value : { summary: value }),
      })).filter((item) => item.chapterNumber < beforeChapter).sort((a, b) => b.chapterNumber - a.chapterNumber).slice(0, limit);
    },
    async loadStoryProfile() { return structuredClone(plans.storyProfile ?? null); },
    async loadStorySpine() { return structuredClone(plans.storySpine ?? null); },
    async loadWriterSkill() { return structuredClone(plans.writerSkill ?? null); },
    async loadStoryIdentity() { return structuredClone(plans.storyIdentity ?? null); },
    async loadPilotContract() { return structuredClone(plans.pilotContract ?? null); },
    async loadArcPlan() { return structuredClone(plans.arcPlan ?? null); },
    async loadEpisodePlan(_workId, chapter) { return structuredClone(plans.episodePlans?.[chapter] ?? null); },
    async loadArtifact(_workId, chapter) { return structuredClone(tree.chapters?.[chapter] ?? null); },
    publishedRevision: published.value,
  };
  return new Proxy(store, {
    get(target, property, receiver) {
      if (Object.hasOwn(own, property)) return own[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
