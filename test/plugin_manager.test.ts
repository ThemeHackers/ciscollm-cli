process.env.NODE_ENV = 'test';
import * as assert from 'assert';
import { PluginManager } from '../src/core/plugins/PluginManager';

console.log('Running PluginManager parser tests...\n');

const parsedSimple = PluginManager.parseScriptCommand('python analyze.py');
assert.strictEqual(parsedSimple.command, 'python', 'Should parse the executable name');
assert.deepStrictEqual(parsedSimple.args, ['analyze.py'], 'Should parse positional arguments');

const parsedQuoted = PluginManager.parseScriptCommand('"C:\\Program Files\\Python\\python.exe" "analyze.py" --flag');
assert.strictEqual(parsedQuoted.command, 'C:\\Program Files\\Python\\python.exe', 'Should preserve quoted executable paths');
assert.deepStrictEqual(parsedQuoted.args, ['analyze.py', '--flag'], 'Should preserve quoted arguments');

const parsedInjectionLike = PluginManager.parseScriptCommand('python analyze.py && whoami');
assert.deepStrictEqual(parsedInjectionLike.args, ['analyze.py', '&&', 'whoami'], 'Shell operators must stay data, not be executed');

assert.throws(() => PluginManager.parseScriptCommand('   '), /empty/i, 'Empty scripts should be rejected');

console.log('PluginManager parser tests passed successfully.');
