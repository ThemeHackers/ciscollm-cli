import { PlinkSerialSession } from '../src/infrastructure/protocols/PlinkSerial';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

async function runTest() {
    console.log('Running Plink Downloader Integration Test...');

    const isWindows = process.platform === 'win32';
    if (!isWindows) {
        console.log(' -> Non-Windows platform. Skipping plink downloader test.');
        process.exit(0);
    }

    const localCwdPath = path.resolve(process.cwd(), 'plink.exe');
    const projectRootPath = path.resolve(__dirname, '..', 'plink.exe');
    const nextToExecPath = path.resolve(__dirname, '..', 'src', 'infrastructure', 'protocols', 'plink.exe');

    let localCwdBackup: Buffer | null = null;
    let projectRootBackup: Buffer | null = null;
    let nextToExecBackup: Buffer | null = null;

    if (fs.existsSync(localCwdPath)) {
        localCwdBackup = fs.readFileSync(localCwdPath);
        fs.unlinkSync(localCwdPath);
    }
    if (fs.existsSync(projectRootPath)) {
        projectRootBackup = fs.readFileSync(projectRootPath);
        fs.unlinkSync(projectRootPath);
    }
    if (fs.existsSync(nextToExecPath)) {
        nextToExecBackup = fs.readFileSync(nextToExecPath);
        fs.unlinkSync(nextToExecPath);
    }

    try {
        const resolvedPath = await PlinkSerialSession.ensurePlinkExecutable();
        console.log(` -> Downloader resolved path: ${resolvedPath}`);
        
        assert.ok(fs.existsSync(resolvedPath), 'Downloaded file should exist');
        assert.ok(resolvedPath.endsWith('plink.exe'), 'File path should end with plink.exe');
        
        const { execSync } = require('child_process');
        const stdout = execSync(`"${resolvedPath}" -V`, { encoding: 'utf8' });
        assert.ok(stdout.includes('plink'), 'Execution output should contain plink version');

        console.log(' -> Plink Downloader Integration Test passed successfully!');
    } catch (e: any) {
        console.error('Integration Test FAILED:', e.stack || e.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(localCwdPath)) fs.unlinkSync(localCwdPath);
        if (fs.existsSync(projectRootPath)) fs.unlinkSync(projectRootPath);
        if (fs.existsSync(nextToExecPath)) fs.unlinkSync(nextToExecPath);

        if (localCwdBackup) fs.writeFileSync(localCwdPath, localCwdBackup);
        if (projectRootBackup) fs.writeFileSync(projectRootPath, projectRootBackup);
        if (nextToExecBackup) fs.writeFileSync(nextToExecPath, nextToExecBackup);
    }
}

runTest().then(() => {
    console.log('Plink Downloader test completed.');
    process.exit(0);
});
