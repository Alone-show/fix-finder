/**
 * 单元测试用的合成索引：结构必须与 lib/store.js 的 rebuildIndex/loadIndex 输出一致
 * （lines + lineHashes + 合成后的 commits，仅 PROD 线，含第二个芯片 T3 用于隔离测试）。
 */
export function makeIndex() {
  const lines = [
    {
      id: 'PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10',
      stage: 'PROD', platform: 'RK', os: 'DEBIAN', product: 'SP2-10PRO', customer: 'CP', lcd: 'LCD10',
      build: 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010', buildDate: '20261010', tip: '1cb8e811',
    },
    {
      id: 'PROD/RK/DEBIAN/SP2-10PLUS/CP/LCD10',
      stage: 'PROD', platform: 'RK', os: 'DEBIAN', product: 'SP2-10PLUS', customer: 'CP', lcd: 'LCD10',
      build: 'CP_SP2-10PLUS_D_V1.09_LCD10_B0_EU_20260907', buildDate: '20260907', tip: 'abc00001',
    },
    {
      id: 'PROD/RK/DEBIAN/MEGA1/CP/LCD10',
      stage: 'PROD', platform: 'RK', os: 'DEBIAN', product: 'MEGA1', customer: 'CP', lcd: 'LCD10',
      build: 'CP_MEGA1_D_V1.07_LCD10_B0_CN_20261016', buildDate: '20261016', tip: 'e0b87d09',
    },
    {
      id: 'PROD/RK/ANDROID/APOLLO2/CP/LCD10',
      stage: 'PROD', platform: 'RK', os: 'ANDROID', product: 'APOLLO2', customer: 'CP', lcd: 'LCD10',
      build: 'CP_APOLLO2_A_V1.10_LCD10_B0_MDM_20261001', buildDate: '20261001', tip: 'abc12345',
    },
    {
      id: 'PROD/RK/LINUX/SP2-10PRO/CP',
      stage: 'PROD', platform: 'RK', os: 'LINUX', product: 'SP2-10PRO', customer: 'CP', lcd: '',
      build: 'CP_SP2-10PRO_L_V1.02_20250623', buildDate: '20250623', tip: 'def67890',
    },
    {
      id: 'PROD/T3/ANDROID/SPRING2/CP/LCD7',
      stage: 'PROD', platform: 'T3', os: 'ANDROID', product: 'SPRING2', customer: 'CP', lcd: 'LCD7',
      build: 'CP_SPRING2_A_V1.03_LCD7_B0_EU_20260930', buildDate: '20260930', tip: 't3aaaaaa',
    },
  ];

  const commits = {
    '92cf9c82': {
      hash: '92cf9c82', date: '2026-08-31', author: 'wenchao.sun',
      subject: 'feat(common): 修复CIF驱动REQBUFS时cif_fmt_out空指针导致的kernel panic',
      scope: 'common', ticket: '', kind: 'feat', revert: false,
      lines: ['PROD/RK/DEBIAN/MEGA1/CP/LCD10'],
    },
    db5ad220: {
      hash: 'db5ad220', date: '2026-09-22', author: 'xin peng',
      subject: 'feat(cp-sp2-10pro): DO-8486 更新cpmedia到2.0.6，更新cputils到2.0.6',
      scope: 'cp-sp2-10pro', ticket: 'DO-8486', kind: 'feat', revert: false,
      lines: ['PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10'],
    },
    '8b959775': {
      hash: '8b959775', date: '2026-07-21', author: 'wanghang',
      subject: 'feat(common): DO-7778 解决camera 热插拔出现图像断层问题',
      scope: 'common', ticket: 'DO-7778', kind: 'feat', revert: false,
      lines: ['PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10'],
    },
    aaaa1111: {
      hash: 'aaaa1111', date: '2026-10-20', author: 'dev',
      subject: 'fix(cp-sp2-10pro): 修复触摸屏偶发无报点的问题',
      scope: 'cp-sp2-10pro', ticket: '', kind: 'fix', revert: false,
      lines: ['PROD/RK/ANDROID/APOLLO2/CP/LCD10'],
    },
    bbbb2222: {
      hash: 'bbbb2222', date: '2026-09-18', author: 'dev2',
      subject: 'fix(common): 修复MIPI sensor 初始化失败导致的花屏',
      scope: 'common', ticket: '', kind: 'fix', revert: false,
      lines: ['PROD/RK/ANDROID/APOLLO2/CP/LCD10'],
    },
    cccc3333: {
      hash: 'cccc3333', date: '2026-09-02', author: 't3dev',
      subject: 'feat(t3-spring2): DO-9001 修复摄像头预览黑屏',
      scope: 't3-spring2', ticket: 'DO-9001', kind: 'feat', revert: false,
      lines: ['PROD/T3/ANDROID/SPRING2/CP/LCD7'],
    },
  };

  const lineHashes = {};
  for (const line of lines) lineHashes[line.id] = [];
  for (const commit of Object.values(commits)) {
    for (const lineId of commit.lines) lineHashes[lineId]?.push(commit.hash);
  }

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    syncedAt: new Date().toISOString(),
    lineCount: lines.length,
    commitCount: Object.keys(commits).length,
    lines,
    lineHashes,
    commits,
    failures: [],
  };
}
