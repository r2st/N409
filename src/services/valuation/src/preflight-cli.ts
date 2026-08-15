/**
 * `node dist/preflight-cli.js` — run the estate's start-up config guards against
 * the deployed environment without starting anything.
 *
 * Run by `infra/deploy.sh` on the host, after the build and before the first
 * `systemctl restart`. That position is the whole value: the guards it runs are
 * the same ones the services run at boot, so the only thing this changes is
 * *when* a bad config is found — and the difference between "the deploy stops,
 * the previous release keeps serving" and "the unit crash-loops with nothing
 * behind it" is the difference between a nuisance and an outage.
 *
 * It is also usable as an `ExecStartPre=` if a deployment would rather have the
 * check in the unit; nothing here touches the database or the network, so it
 * costs a few milliseconds.
 *
 *   --env-file PATH   Validate this file wherever a unit names an
 *                     EnvironmentFile. Defaults to honouring the path in the
 *                     unit, which is right on the host and wrong everywhere
 *                     else, since the units name /opt/N409/.env.
 *   --unit-dir PATH   Where the .service files are (default: infra/systemd next
 *                     to this checkout).
 *   --inherit-env     Also consider the variables in this process's environment.
 *                     Off by default: the deploy shell's variables are not the
 *                     ones the services boot with, and letting one satisfy a
 *                     guard here would hide exactly the fault being looked for.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFaults, preflight } from './preflight.js';

function parseArgs(argv: string[]): { envFile?: string; unitDir?: string; inheritEnv: boolean } {
  const out: { envFile?: string; unitDir?: string; inheritEnv: boolean } = { inheritEnv: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--env-file') out.envFile = argv[++i];
    else if (arg === '--unit-dir') out.unitDir = argv[++i];
    else if (arg === '--inherit-env') out.inheritEnv = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('usage: preflight-cli [--env-file PATH] [--unit-dir PATH] [--inherit-env]\n');
      process.exit(0);
    } else {
      process.stderr.write(`n409-preflight: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
// dist/preflight-cli.js → src/services/valuation → repo root is four levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const unitDir = args.unitDir ?? path.join(repoRoot, 'infra/systemd');

const result = preflight({
  unitDir,
  ...(args.envFile ? { resolveEnvFile: () => args.envFile! } : {}),
  baseEnv: args.inheritEnv ? process.env : {},
});

if (result.faults.length > 0) {
  process.stderr.write(`n409-preflight: ${formatFaults(result)}\n`);
  process.stderr.write(
    'n409-preflight: these would each have been found at boot, by the service failing to start.\n',
  );
  process.exit(1);
}

process.stdout.write(`n409-preflight: ${result.units.length} unit(s) validated, no configuration faults\n`);
