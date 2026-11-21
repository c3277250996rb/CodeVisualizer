import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));
const testUserDataPath = process.env.CODEVISUALIZER_TEST_USER_DATA ||
	path.join(workspaceRoot, '.vscode-test', 'light-user-data');
const testSettingsPath = path.join(testUserDataPath, 'User', 'settings.json');

mkdirSync(path.dirname(testSettingsPath), { recursive: true });
writeFileSync(
	testSettingsPath,
	JSON.stringify({
		'window.autoDetectColorScheme': true,
		'workbench.colorTheme': 'Light Modern',
	}, null, 2),
);

export default defineConfig({
	files: 'out/test/**/*.test.js',
	launchArgs: [
		`--user-data-dir=${testUserDataPath}`,
	],
	useInstallation: {
		fromPath: 'C:\\Program Files\\Microsoft VS Code\\code.exe',
	},
});
