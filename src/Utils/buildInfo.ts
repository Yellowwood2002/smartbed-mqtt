import fs from 'fs';
import path from 'path';

type BuildInfo = {
  fork: string;
  version: string | null;
  gitSha: string;
  buildTime: string;
};

/**
 * Runtime build fingerprint (project memory)
 *
 * Why:
 * - Home Assistant add-on rebuilds/reinstalls can accidentally keep pointing at an upstream repo
 *   or a cached build.
 * - A stable, machine-readable fingerprint in logs makes it unambiguous what code is running.
 *
 * How:
 * - Prefer files baked into the container at build time: `.gitsha`, `.buildtime`, `package.json`.
 * - Fall back to env vars if a builder injects them.
 * - Always return a value (never throw) so startup isn't blocked by missing metadata.
 */
export function getBuildInfo(): BuildInfo {
  const cwd = process.cwd();
  const readTextFile = (filename: string): string | null => {
    try {
      const p = path.join(cwd, filename);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      return null;
    }
  };

  const fork = 'Yellowwood2002';
  const gitSha =
    process.env.SMARTBEDMQTT_GIT_SHA ||
    process.env.GITHUB_SHA ||
    readTextFile('.gitsha') ||
    'unknown';
  const buildTime =
    process.env.SMARTBEDMQTT_BUILD_TIME || readTextFile('.buildtime') || new Date().toISOString();

  let version: string | null = null;
  try {
    const p = path.join(cwd, 'package.json');
    if (fs.existsSync(p)) {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof pkg?.version === 'string') version = pkg.version;
    }
  } catch {
    // ignore
  }

  return { fork, version, gitSha, buildTime };
}

