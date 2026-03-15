# ============================================
# Export project to a single text file
# ============================================
# Usage:
#   .\export-project.ps1                    # export source files only (src, test, config)
#   .\export-project.ps1 -All               # export entire project
#   .\export-project.ps1 -Output "out.txt"  # specify output file
#   .\export-project.ps1 -Extensions .ts,.tsx,.js,.json # only specific extensions
# ============================================

param(
    [string]$ProjectPath = $PSScriptRoot,
    [string]$OutputFile = "project-export.txt",
    [switch]$All,
    [string[]]$Extensions = @(),
    [string]$Delimiter = "="
)

# Directories to exclude (when not using -All)
$ExcludeDirs = @(
    'node_modules', 'dist', 'build', 'out', '.git', '.vscode', '.idea',
    'test', 'tests', '__tests__',
    'coverage', '.nyc_output', 'historical_data', 'candles', 'klines',
    'market_data', 'backtest_results', 'results', 'trades', 'orders',
    'reports', 'charts', 'plots', 'models', 'data', 'cache', '.temp',
    '.cache', '.parcel-cache', '.cursor', '__pycache__', '.next', '.nuxt'
)

# Extensions to include (when not specified - all text files)
$TextExtensions = @('.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yml', '.yaml', 
    '.env', '.env.example', '.gitignore', '.ps1', '.sh', '.bat', '.css', '.scss', 
    '.html', '.xml', '.sql', '.txt', '.cfg', '.ini', '.toml')

# Delimiter character (repeated for visual emphasis)
$DelimiterChar = if ($Delimiter -eq "=") { "=" } else { $Delimiter }
$LineWidth = 80
$HeaderLine = $DelimiterChar * $LineWidth

function Get-ProjectFiles {
    param([switch]$IncludeAll)
    
    $files = Get-ChildItem -Path $ProjectPath -Recurse -File -ErrorAction SilentlyContinue
    
    $result = @()
    foreach ($file in $files) {
        $relativePath = $file.FullName.Replace($ProjectPath, "").TrimStart("\", "/")
        
        # Skip excluded directories
        if (-not $IncludeAll) {
            $skip = $false
            foreach ($dir in $ExcludeDirs) {
                if ($relativePath -like "*\$dir\*" -or $relativePath -like "*/$dir/*" -or 
                    $relativePath -like "$dir\*" -or $relativePath -like "$dir/*") {
                    $skip = $true
                    break
                }
            }
            if ($skip) { continue }
        }
        
        # Filter by extensions
        if ($Extensions.Count -gt 0) {
            $ext = [System.IO.Path]::GetExtension($file.Name).ToLower()
            if ($Extensions -notcontains $ext) { continue }
        } elseif (-not $IncludeAll) {
            $ext = [System.IO.Path]::GetExtension($file.Name).ToLower()
            if ($TextExtensions -notcontains $ext) { continue }
        }
        
        # Skip package-lock.json, .gitignore, and this export script
        if ($file.Name -eq 'package-lock.json' -or $file.Name -eq '.gitignore' -or $file.Name -eq 'export.ps1') { continue }
        
        # Skip binary and large files
        try {
            $content = Get-Content -Path $file.FullName -Raw -ErrorAction Stop -Encoding UTF8
            if ($content -match '[\x00-\x08\x0B\x0C\x0E-\x1F]' -and $content.Length -gt 1000) {
                continue  # likely binary file
            }
        } catch {
            continue  # failed to read
        }
        
        $result += @{ Path = $relativePath; FullPath = $file.FullName }
    }
    
    return $result | Sort-Object { $_.Path }
}

# --- Main logic ---
$OutputPath = Join-Path $ProjectPath $OutputFile
$projectName = Split-Path $ProjectPath -Leaf
$exportDate = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine("$HeaderLine")
[void]$sb.AppendLine(" PROJECT EXPORT: $projectName")
[void]$sb.AppendLine(" Date: $exportDate")
[void]$sb.AppendLine(" Mode: $(if ($All) { 'ALL' } else { 'Source only' })")
[void]$sb.AppendLine("$HeaderLine")
[void]$sb.AppendLine("")

$files = Get-ProjectFiles -IncludeAll:$All
$fileCount = 0

foreach ($f in $files) {
    $fileCount++
    $content = Get-Content -Path $f.FullPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    
    [void]$sb.AppendLine("$HeaderLine")
    [void]$sb.AppendLine(" FILE #$fileCount : $($f.Path)")
    [void]$sb.AppendLine("$HeaderLine")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine($content)
    [void]$sb.AppendLine("")
}

$result = $sb.ToString()
$result | Out-File -FilePath $OutputPath -Encoding UTF8

Write-Host "Exported files: $fileCount" -ForegroundColor Green
Write-Host "Output saved to: $OutputPath" -ForegroundColor Cyan
