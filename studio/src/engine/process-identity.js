import { execFileSync } from 'node:child_process';

// Failure remains unknown; neither lease consumer may infer that a PID is dead.
export function incarnation(pid) {
  try {
    return (
      execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() || null
    );
  } catch {
    return null;
  }
}
