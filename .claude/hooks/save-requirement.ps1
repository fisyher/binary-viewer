# Saves prompts containing a "# Requirement" markdown header to requirements/<timestamp>.md
$ErrorActionPreference = 'Stop'

$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$prompt  = $payload.prompt

# Match any header level: "# Requirement", "## Requirements", etc.
if ($prompt -notmatch '(?m)^\s{0,3}#{1,6}\s*Requirements?\b') { exit 0 }

$root = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { $payload.cwd }
$dir  = Join-Path $root 'requirements'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$now  = Get-Date
$name = '{0}.md' -f $now.ToString('yyyy-MM-dd_HHmmss')
$path = Join-Path $dir $name

$content = @"
---
captured: $($now.ToString('yyyy-MM-ddTHH:mm:ssK'))
session: $($payload.session_id)
---

$prompt
"@

[IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding $false))

# On UserPromptSubmit, stdout is added to Claude's context
Write-Output "Requirement saved to requirements/$name"
