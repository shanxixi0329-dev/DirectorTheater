'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const { build: packageConfig, version } = require('../package.json');
const thumbprintVariable = 'DIRECTOR_THEATER_SIGNING_THUMBPRINT';

function queryWindows(command, variables) {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const output = execFileSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; ' + command
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...variables },
    windowsHide: true
  });
  return JSON.parse(output.trim().replace(/^\uFEFF/, ''));
}

function requireCodeSigningCertificate(thumbprint) {
  const certificate = queryWindows(String.raw`
    $now = Get-Date
    $certificate = Get-ChildItem -Path 'Cert:\CurrentUser\My','Cert:\LocalMachine\My' -CodeSigningCert |
      Where-Object { $_.Thumbprint -eq $env:DIRECTOR_THEATER_SIGNING_THUMBPRINT -and
        $_.HasPrivateKey -and $_.NotBefore -le $now -and $_.NotAfter -gt $now } |
      Select-Object -First 1
    if ($certificate) { $certificate | Select-Object Subject | ConvertTo-Json -Compress }
    else { 'null' }
  `, { [thumbprintVariable]: thumbprint });
  if (!certificate) throw new Error('The selected code-signing certificate with an accessible private key is missing or expired.');
  return certificate;
}

function verifySignature(file, thumbprint) {
  const signature = queryWindows(`
    $signature = Get-AuthenticodeSignature -LiteralPath $env:DIRECTOR_THEATER_SIGNING_TARGET
    [pscustomobject]@{
      status = $signature.Status.ToString()
      type = $signature.SignatureType.ToString()
      thumbprint = $signature.SignerCertificate.Thumbprint
      timestamped = [bool]$signature.TimeStamperCertificate
    } | ConvertTo-Json -Compress
  `, { DIRECTOR_THEATER_SIGNING_TARGET: path.resolve(file) });
  const name = path.basename(file);
  if (signature.status !== 'Valid' || signature.type !== 'Authenticode') {
    throw new Error(`${name}: valid embedded Authenticode signature required (Windows status: ${signature.status}).`);
  }
  if (signature.thumbprint !== thumbprint) throw new Error(`${name}: unexpected signing certificate.`);
  if (!signature.timestamped) throw new Error(`${name}: signature timestamp missing.`);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The signed Windows build requires a Windows host.');
  const thumbprint = (process.env[thumbprintVariable] || '').replace(/\s/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(thumbprint)) {
    throw new Error(`Set ${thumbprintVariable} to the 40-character thumbprint of the Windows code-signing certificate.`);
  }
  const certificate = requireCodeSigningCertificate(thumbprint);
  console.log(`Windows publisher: ${certificate.Subject}`);

  const signedRoot = path.join(projectDir, packageConfig.directories.output, 'signed');
  fs.mkdirSync(signedRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(signedRoot, `${version}-`));
  const buildDir = path.join(runDir, 'build');
  const { Arch, Platform, build } = require('electron-builder');
  await build({
    projectDir,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: {
      directories: { output: buildDir },
      win: {
        forceCodeSigning: true,
        signtoolOptions: {
          certificateSha1: thumbprint,
          signingHashAlgorithms: ['sha256'],
          rfc3161TimeStampServer: 'http://timestamp.digicert.com'
        }
      }
    }
  });

  const installerName = packageConfig.nsis.artifactName.replace('${version}', version).replace('${ext}', 'exe');
  const installer = path.join(buildDir, installerName);
  verifySignature(path.join(buildDir, 'win-unpacked', `${packageConfig.productName}.exe`), thumbprint);
  verifySignature(installer, thumbprint);

  const digest = createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  const releaseDir = path.join(runDir, 'release');
  fs.mkdirSync(releaseDir);
  fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${digest}  ${installerName}\n`, { flag: 'wx' });
  fs.renameSync(installer, path.join(releaseDir, installerName));
  console.log(`Verified installer and SHA-256: ${releaseDir}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { verifySignature };
