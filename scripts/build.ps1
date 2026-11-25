#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-plan-superagent —— Windows 构建脚本（对应 plan-board 的 scripts/build.sh）。

.DESCRIPTION
    两步构建，全部用**包内 node_modules**，不依赖 bash、不依赖 DSH 源码 checkout：

      1. tsc -p tsconfig.json   src/**  → lib/**（含 lib/types/** 的 .d.ts）
      2. tsdown                 src/client/index.ts → lib/client.js（CJS，react 等为 external）

    失败即非零退出，并把原因打印到 stderr。

    前提：包内已装好依赖（首次开发时先跑一次）：
        npm install          # 或 pnpm install
    依赖必须包含（缺一个都会让构建失败）：
        typescript、tsdown、@types/node、
        @deepseek-ai/cordis、@deepseek-ai/schemastery、@deepseek-ai/dsh-tools

.EXAMPLE
    pwsh -File scripts/build.ps1
    构建产物（lib/）必须随仓库一起提交：别人从 GitHub 安装时免本地构建。

.EXAMPLE
    pwsh -File scripts/build.ps1 -SkipClient
    只编 src/** → lib/**，跳过面板（lib/client.js）。

.NOTES
    产物布局：
        lib/index.js        插件入口（板 + 桥 + 规划器）
        lib/types/index.d.ts
        lib/board/**、lib/bridge/**、lib/planner/**
        lib/client.js       浏览器面板（由 tsdown 产出）
#>
[CmdletBinding()]
param(
    [switch]$SkipClient,
    [switch]$SkipTypes
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Error "build: 找不到包根目录（从 $PSScriptRoot 上溯失败）。" -ErrorAction Continue
    exit 1
}
Set-Location -LiteralPath $Root

function Write-Step([string]$Message) {
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Write-Fail([string]$Message, [int]$Code = 1) {
    Write-Host "build: $Message" -ForegroundColor Red
    Write-Host "build: 失败（退出码 $Code）。" -ForegroundColor Red
    exit $Code
}

# 包内 node_modules 里的可执行文件：Windows 用 .cmd，POSIX 用无扩展名壳脚本。
function Resolve-Bin([string]$Name) {
    $candidates = @(
        (Join-Path $Root "node_modules/.bin/$Name.cmd"),
        (Join-Path $Root "node_modules/.bin/$Name"),
        (Join-Path $Root "node_modules/.bin/$Name.ps1")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

Write-Step "dsh-plan-superagent build"
Write-Host "包根目录: $Root"

# ---------- 0. 前置检查 ----------
$ModulesDir = Join-Path $Root 'node_modules'
if (-not (Test-Path -LiteralPath $ModulesDir)) {
    Write-Fail "包内没有 node_modules。请先在包根目录执行 `npm install`（或 `pnpm install`），再跑本脚本。本脚本不依赖 DSH 源码 checkout，也不联网拉依赖。"
}

$RequiredModules = @(
    'typescript',
    'tsdown',
    '@types/node',
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-tools'
)
$missing = @()
foreach ($module in $RequiredModules) {
    if (-not (Test-Path -LiteralPath (Join-Path $ModulesDir $module))) { $missing += $module }
}
if ($missing.Count -gt 0) {
    Write-Fail "包内 node_modules 缺少：$($missing -join ', ')。请执行 `npm install`（或 `pnpm install`）补齐后重试。"
}

# ---------- 1. tsc：src/** → lib/** ----------
if (-not $SkipTypes) {
    $tsc = Resolve-Bin 'tsc'
    if ($null -eq $tsc) { Write-Fail "找不到 typescript 可执行文件（node_modules/.bin/tsc）。请执行 `npm install`。" }

    Write-Step "编译 src -> lib（tsc）"
    & $tsc -p tsconfig.json
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Fail "tsc 编译失败（退出码 $code）。上面的 TS 报错即为原因；常见于 src/bridge、src/planner 尚未写完，或依赖类型缺失。" $code
    }
} else {
    Write-Step "跳过 src -> lib（-SkipTypes）"
}

# ---------- 1.5 面板类型检查（src/client 被包级 tsconfig 排除，这里单独查） ----------
if (-not $SkipClient) {
    $tscClient = Resolve-Bin 'tsc'
    $clientConfig = Join-Path $Root 'tsconfig.client.json'
    if ((Test-Path -LiteralPath $clientConfig) -and ($null -ne $tscClient)) {
        Write-Step "类型检查面板（tsc -p tsconfig.client.json）"
        & $tscClient -p tsconfig.client.json
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            Write-Fail "面板类型检查失败（退出码 $code）。src/client 不在包级 tsconfig 里，这一关是它唯一的编译门禁。" $code
        }
    } else {
        Write-Host "  --  跳过面板类型检查（缺 tsconfig.client.json 或 tsc）" -ForegroundColor Yellow
    }
}

# ---------- 2. tsdown：src/client/index.ts → lib/client.js ----------
if (-not $SkipClient) {
    $tsdown = Resolve-Bin 'tsdown'
    if ($null -eq $tsdown) { Write-Fail "找不到 tsdown 可执行文件（node_modules/.bin/tsdown）。请执行 `npm install`。" }

    Write-Step "打包面板 src/client -> lib/client.js（tsdown）"
    & $tsdown
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Fail "tsdown 打包失败（退出码 $code）。上面的报错即为原因。" $code
    }
} else {
    Write-Step "跳过面板打包（-SkipClient）"
}

# ---------- 3. 产物核对 ----------
Write-Step "核对产物"
$Expected = @(
    'lib/index.js',
    'lib/board/index.js',
    'lib/client.js'
)
$absent = @()
foreach ($artifact in $Expected) {
    $full = Join-Path $Root $artifact
    if (Test-Path -LiteralPath $full) {
        $size = (Get-Item -LiteralPath $full).Length
        Write-Host ("  ok  {0}  ({1:N0} bytes)" -f $artifact, $size) -ForegroundColor Green
    } else {
        Write-Host ("  --  {0}  (缺失)" -f $artifact) -ForegroundColor Yellow
        $absent += $artifact
    }
}
if (-not $SkipTypes -and $absent -contains 'lib/index.js') {
    Write-Fail "构建没有产出 lib/index.js，产物不完整。"
}

Write-Step "构建完成"
Write-Host "记得把 lib/ 一起提交（GitHub 安装依赖它，用户免本地构建）。" -ForegroundColor Green
exit 0