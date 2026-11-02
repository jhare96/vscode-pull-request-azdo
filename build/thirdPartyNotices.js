/*---------------------------------------------------------------------------------------------
 *  Copyright (c) jhare96. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const fs = require('fs');
const path = require('path');

function packageRoot(resource) {
	const parts = resource.split(/[\\/]/);
	const index = parts.lastIndexOf('node_modules');
	if (index < 0 || !parts[index + 1]) {
		return undefined;
	}
	return parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join(path.sep);
}

function packageNotice(directory) {
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
	const files = fs.readdirSync(directory).filter(name =>
		/^(licen[cs]e|copying|notice|copyright|thirdpartynotices)([.-].*)?$/i.test(name)
		&& fs.statSync(path.join(directory, name)).isFile()).sort();
	if (!files.length) {
		const readme = fs.readdirSync(directory).find(name => /^readme([.-].*)?$/i.test(name));
		if (readme) {
			files.push(readme);
		}
	}
	const texts = files.map(name => `${name}\n${fs.readFileSync(path.join(directory, name), 'utf8').trim()}`);
	const supplemental = path.join(__dirname, 'licenses', `${manifest.name.replace(/\//g, '-')}-${manifest.version}.txt`);
	if (fs.existsSync(supplemental)) {
		texts.push(fs.readFileSync(supplemental, 'utf8').trim());
	}
	if (!texts.some(text => /permission is hereby granted|permission to use, copy|permission to copy, modify, and distribute|redistribution and use|apache license|mozilla public license|isc license|sil open font license/i.test(text.replace(/\s+/g, ' ')))) {
		throw new Error(`Missing full licence text for bundled dependency ${manifest.name}. Add its notices before distributing.`);
	}
	if (manifest.name === 'es6-string-polyfills') {
		for (const name of Object.keys(manifest.dependencies)) {
			texts.push(packageNotice(path.dirname(require.resolve(`${name}/package.json`, { paths: [directory] }))));
		}
	}
	return [
		`${manifest.name}@${manifest.version}`,
		`Licence: ${typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? manifest.licenses)}`,
		...texts,
	].join('\n\n');
}

class ThirdPartyNoticesPlugin {
	apply(compiler) {
		compiler.hooks.thisCompilation.tap('ThirdPartyNoticesPlugin', compilation => {
			compilation.hooks.processAssets.tap({
				name: 'ThirdPartyNoticesPlugin',
				stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
			}, () => {
				const directories = new Set();
				function collect(modules) {
					for (const module of modules) {
						if (module.resource) {
							const directory = packageRoot(module.resource);
							if (directory) {
								directories.add(directory);
							}
						}
						if (module.modules) {
							collect(module.modules);
						}
					}
				}
				collect(compilation.modules);
				// Codicon assets also ship directly under resources/, outside the module graph.
				directories.add(path.dirname(require.resolve('@vscode/codicons/package.json')));
				const errors = [];
				const entries = [...directories].map(directory => {
					try {
						return packageNotice(directory);
					} catch (error) {
						errors.push(error.message);
						return '';
					}
				});
				if (errors.length) {
					throw new Error(errors.sort().join('\n'));
				}
				const notices = entries.sort().join('\n\n----------------------------------------\n\n');
				const name = `${compiler.name.replace(/:/g, '-')}-ThirdPartyNotices.txt`;
				compilation.emitAsset(name, new compiler.webpack.sources.RawSource(
					`Third-party components bundled with Azure DevOps Pull Requests (Unofficial).\n`
					+ `Each component is provided under its own licence below.\n\n${notices}\n`,
				));
			});
		});
	}
}

module.exports = { ThirdPartyNoticesPlugin, packageRoot, packageNotice };
