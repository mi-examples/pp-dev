import * as path from 'path';
import * as fs from 'fs';
import { type CLIShortcut } from '../shortcuts.js';
import { colors } from '../lib/helpers/color.helper.js';

let profileSession = (global as any).__pp_dev_profile_session;
let profileCount = 0;

export const stopProfiler = (log: (message: string) => void): void | Promise<void> => {
  if (!profileSession) {
    return;
  }

  return new Promise((res, rej) => {
    profileSession!.post('Profiler.stop', (err: any, { profile }: any) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const outPath = path.resolve(`./pp-dev-profile-${profileCount++}.cpuprofile`);

        fs.writeFileSync(outPath, JSON.stringify(profile));
        log(colors.yellow(`CPU profile written to ${colors.white(colors.dim(outPath))}`));
        profileSession = undefined;
        res();
      } else {
        rej(err);
      }
    });
  });
};

/**
 * The `p` shortcut of `pp-dev` when it was started with `--profile`: stops the profiler and writes
 * the profile, or starts it again. None otherwise.
 */
export function profilerShortcuts(log: (message: string) => void): CLIShortcut[] {
  if (!profileSession) {
    return [];
  }

  return [
    {
      key: 'p',
      description: 'start/stop the profiler',
      async action() {
        if (profileSession) {
          await stopProfiler(log);
        } else {
          const inspector = await import('node:inspector').then((r) => (r as any).default);

          await new Promise<void>((res) => {
            profileSession = new inspector.Session();
            profileSession.connect();
            profileSession.post('Profiler.enable', () => {
              profileSession?.post('Profiler.start', () => {
                log('Profiler started');

                res();
              });
            });
          });
        }
      },
    },
  ];
}
