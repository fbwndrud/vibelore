/**
 * Shared primitives used across the engine core.
 *
 * Kept dependency-free so any subsystem (continuity, generators, cli, host
 * application adapters) can import these without pulling in heavier modules.
 */
/** Runtime list of all cast modalities — for validation / iteration. */
export const CAST_MODALITIES = [
    'text',
    'visual_novel',
    'webtoon',
    'comic',
    'audio',
    'music',
    'video',
    'game',
];
