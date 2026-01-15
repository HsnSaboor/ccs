/**
 * Version Command Handler
 *
 * Handle --version command for CCS.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { initUI, header, subheader, color, warn } from '../utils/ui';
import { getConfigPath } from '../utils/config-manager';
import { getVersion } from '../utils/version';

/**
 * Handle version command
 */
export async function handleVersionCommand(): Promise<void> {
  await initUI();
  console.log(header(`CCS (Claude Code Switch) v${getVersion()} (HsnSaboor-patch)`));
  console.log('');

  console.log(subheader('Installation:'));
  const installLocation = process.argv[1] || '(not found)';
  console.log(`  ${color('Location:'.padEnd(17), 'info')} ${installLocation}`);

  const ccsDir = path.join(os.homedir(), '.ccs');
  console.log(`  ${color('CCS Directory:'.padEnd(17), 'info')} ${ccsDir}`);

  const configPath = getConfigPath();
  console.log(`  ${color('Config:'.padEnd(17), 'info')} ${configPath}`);

  const profilesJson = path.join(os.homedir(), '.ccs', 'profiles.json');
  console.log(`  ${color('Profiles:'.padEnd(17), 'info')} ${profilesJson}`);

  // Delegation status
  const delegationSessionsPath = path.join(os.homedir(), '.ccs', 'delegation-sessions.json');
  const delegationConfigured = fs.existsSync(delegationSessionsPath);

  const readyProfiles: string[] = [];

  // Check for profiles with valid API keys
  for (const profile of ['glm', 'kimi']) {
    const settingsPath = path.join(os.homedir(), '.ccs', `${profile}.settings.json`);
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const apiKey = settings.env?.ANTHROPIC_AUTH_TOKEN;
        if (apiKey && !apiKey.match(/YOUR_.*_API_KEY_HERE/) && !apiKey.match(/sk-test.*/)) {
          readyProfiles.push(profile);
        }
      } catch (_error) {
        // Invalid JSON, skip
      }
    }
  }

  const hasValidApiKeys = readyProfiles.length > 0;
  const delegationEnabled = delegationConfigured || hasValidApiKeys;

  if (delegationEnabled) {
    console.log(`  ${color('Delegation:'.padEnd(17), 'info')} Enabled`);
  } else {
    console.log(`  ${color('Delegation:'.padEnd(17), 'info')} Not configured`);
  }

  console.log('');

  if (readyProfiles.length > 0) {
    console.log(subheader('Delegation Ready:'));
    console.log(
      `  ${color('[OK]', 'warning')} ${readyProfiles.join(', ')} profiles are ready for delegation`
    );
    console.log('');
  } else if (delegationEnabled) {
    console.log(subheader('Delegation Ready:'));
    console.log(warn('Delegation configured but no valid API keys found'));
    console.log('');
  }

  console.log(`${subheader('Documentation:')} ${color('https://docs.ccs.kaitran.ca', 'path')}`);
  console.log(`${subheader('License:')} MIT`);
  console.log('');
  console.log(color("Run 'ccs --help' for usage information", 'command'));

  process.exit(0);
}
