import { readFileSync, writeFileSync } from 'fs';
import { platform } from 'os';
import { resolve } from 'path';

import { getOctokit, context } from '@actions/github';

import { uploadAssets } from './upload-release-assets';
import { getAssetName } from './utils';

import type { Artifact, TargetInfo } from './types';

type Platform = {
  signature: string;
  url: string;
};

type VersionContent = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    [key: string]: Platform;
  };
};

export async function uploadVersionJSON({
  version,
  notes,
  tagName,
  releaseId,
  artifacts,
  targetInfo,
  repo
}: {
  version: string;
  notes: string;
  tagName: string;
  releaseId: number;
  artifacts: Artifact[];
  targetInfo: TargetInfo;
  repo: string;
}) {
  if (process.env.GITHUB_TOKEN === undefined) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const github = getOctokit(process.env.GITHUB_TOKEN);

  const versionFilename = 'latest.json';
  const versionFile = resolve(process.cwd(), versionFilename);
  const versionContent: VersionContent = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {},
  };

  const assets = await github.rest.repos.listReleaseAssets({
    owner: context.repo.owner,
    repo: repo || context.repo.repo,
    release_id: releaseId,
    per_page: 50,
  });
  const asset = assets.data.find((e) => e.name === versionFilename);

  if (asset) {
    const assetData = (
      await github.request(
        'GET /repos/{owner}/{repo}/releases/assets/{asset_id}',
        {
          owner: context.repo.owner,
          repo: repo || context.repo.repo,
          asset_id: asset.id,
          headers: {
            accept: 'application/octet-stream',
          },
        }
      )
    ).data as unknown as ArrayBuffer;

    versionContent.platforms = JSON.parse(
      Buffer.from(assetData).toString()
    ).platforms;
  }

  const sigFile = artifacts.find((s) => s.path.endsWith('.sig'));
  const assetNames = new Set(
    artifacts.map((p) => getAssetName(p.path).trim().replace(/ /g, '.')) // GitHub replaces spaces in asset names with dots
  );
  let downloadUrl = assets.data
    .filter((e) => assetNames.has(e.name))
    .find(
      (s) => s.name.endsWith('.tar.gz') || s.name.endsWith('.zip')
    )?.browser_download_url;

  // Untagged release downloads won't work after the release was published
  downloadUrl = downloadUrl?.replace(
    /\/download\/(untagged-[^/]+)\//,
    tagName ? `/download/${tagName}/` : '/latest/download/'
  );

  let os = targetInfo.platform as string;
  if (os === 'macos') {
    os = 'darwin';
  }

  if (downloadUrl && sigFile) {
    let arch = sigFile.arch;
    arch =
      arch === 'amd64' || arch === 'x86_64' || arch === 'x64'
        ? 'x86_64'
        : arch === 'x86' || arch === 'i386'
        ? 'i686'
        : arch === 'arm'
        ? 'armv7'
        : arch === 'arm64'
        ? 'aarch64'
        : arch;

    // https://github.com/tauri-apps/tauri/blob/fd125f76d768099dc3d4b2d4114349ffc31ffac9/core/tauri/src/updater/core.rs#L856
    (versionContent.platforms[`${os}-${arch}`] as unknown) = {
      signature: readFileSync(sigFile.path).toString(),
      url: downloadUrl,
    };

    writeFileSync(versionFile, JSON.stringify(versionContent, null, 2));

    if (asset) {
      // https://docs.github.com/en/rest/releases/assets#update-a-release-asset
      await github.rest.repos.deleteReleaseAsset({
        owner: context.repo.owner,
        repo: repo || context.repo.repo,
        release_id: releaseId,
        asset_id: asset.id,
      });
    }

    console.log(`Uploading ${versionFile}...`);
    await uploadAssets(releaseId, [{ path: versionFile, arch: '' }], repo);
  } else {
    const missing = downloadUrl
      ? 'Signature'
      : sigFile
      ? 'Asset'
      : 'Asset and signature';
    console.warn(
      `${missing} not found for the updater JSON. Skipping upload...`
    );
  }
}
