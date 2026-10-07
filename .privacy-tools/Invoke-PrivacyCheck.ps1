#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Repo,
    [ValidateSet('Staged','Index','History')][string]$Mode = 'Staged',
    [string]$Policy,
    [string]$CommitMessagePath,
    [string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Findings = [Collections.Generic.List[object]]::new()
$script:Seen = [Collections.Generic.HashSet[string]]::new()
$script:PrivateTerms = [Collections.Generic.List[string]]::new()
$script:BinaryReviews = @{}
$script:Scanned = 0
$script:ReviewedBinary = 0
$script:Utf8 = [Text.UTF8Encoding]::new($false, $true)
$script:EmailPattern = '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}'
$script:SecretPatterns = @{
    'github-token' = '\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b'
    'api-key' = '\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b'
    'aws-access-key' = '\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'
    'private-key' = '-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'
    'credential-value' = '(?i)(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["''][A-Za-z0-9_+/=\-]{20,}["'']'
    'credential-url' = '(?i)\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s/@:]+:[^\s/@]+@'
}

function Get-GitBytes {
    param([string[]]$Arguments, [byte[]]$InputBytes)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $script:GitExecutable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $true
    foreach ($argument in @('-c','core.quotepath=false','-C',$script:RepoPath) + $Arguments) {
        $start.ArgumentList.Add($argument)
    }
    foreach ($key in @($start.Environment.Keys)) {
        if ($key.StartsWith('GIT_TRACE') -or $key -eq 'GIT_CURL_VERBOSE') { [void]$start.Environment.Remove($key) }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $memory = [IO.MemoryStream]::new()
    try {
        $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($memory)
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($null -ne $InputBytes -and $InputBytes.Length) {
            $process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
        }
        $process.StandardInput.Close()
        $process.WaitForExit()
        [void]$stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'GitReadFailed' }
        return ,$memory.ToArray()
    } finally { $memory.Dispose(); $process.Dispose() }
}

function Get-GitText {
    param([string[]]$Arguments)
    return $script:Utf8.GetString((Get-GitBytes -Arguments $Arguments))
}

function Safe-Location {
    param([string]$Location)
    $safe = $Location
    foreach ($term in $script:PrivateTerms) {
        $safe = [regex]::Replace($safe, [regex]::Escape($term), '<private-marker>', 'IgnoreCase')
    }
    foreach ($pattern in $script:SecretPatterns.Values) {
        $safe = [regex]::Replace($safe, $pattern, '<credential>')
    }
    $safe = [regex]::Replace($safe, $script:EmailPattern, '<email>')
    return [regex]::Replace($safe, '[\x00-\x1f\x7f]', '?')
}

function Add-Finding {
    param([ValidateSet('block','review')][string]$Level, [string]$Rule, [string]$Location, [int]$Line = 0)
    $safe = Safe-Location $Location
    $key = "$Level|$Rule|$safe|$Line"
    if ($script:Seen.Add($key)) {
        $script:Findings.Add([pscustomobject]@{ level=$Level; rule=$Rule; location=$safe; line=$Line })
    }
}

function Test-AllowedEmail {
    param([string]$Email, [switch]$Identity)
    $value = $Email.ToLowerInvariant()
    if ($value -match '^[A-Za-z0-9._%+\-]+@users\.noreply\.github\.com$') { return $true }
    if ($script:AllowedCommitEmails.Contains($value)) { return $true }
    if ($Identity) { return $false }
    if ($value -match '@(?:example\.(?:com|org|net|test)|[^@]+\.example)$') { return $true }
    return $script:AllowedPublicEmails.Contains($value)
}

function Test-Text {
    param([string]$Text, [string]$Location)
    $lineNumber = 0
    foreach ($line in ($Text -split "`n")) {
        $lineNumber++
        foreach ($entry in $script:SecretPatterns.GetEnumerator()) {
            if ($line -match $entry.Value) { Add-Finding block $entry.Key $Location $lineNumber }
        }
        if ($line -match '(?i)(?:\b[A-Z]:[\\/]|/(?:home|Users)/[^/\s<>"'']+|\\\\[^\\\s]+\\[^\\\s]+)') {
            Add-Finding block 'absolute-or-user-path' $Location $lineNumber
        }
        foreach ($term in $script:PrivateTerms) {
            if ($line.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Add-Finding block 'known-private-marker' $Location $lineNumber
                break
            }
        }
        foreach ($match in [regex]::Matches($line, $script:EmailPattern)) {
            if (-not (Test-AllowedEmail $match.Value)) { Add-Finding review 'email-needs-source-review' $Location $lineNumber }
        }
    }
}

function Test-FileName {
    param([string]$Name)
    $normalized = $Name.Replace('\','/')
    $leaf = ($normalized -split '/')[-1]
    if (($leaf -match '^\.env(?:\..+)?$' -and $leaf -notin @('.env.example','.env.sample','.env.template')) -or
        $leaf -match '^(?:id_rsa|id_ed25519|credentials\.json|auth\.json|settings\.local\.json|\.privacy\.local\.json)$' -or
        $normalized -match '(?i)(?:^|/)(?:private-backup|private-audit|raw-sessions)/' -or
        $leaf -match '(?i)\.original\.bundle$') {
        Add-Finding block 'private-file-name' $Name
    }
    foreach ($term in $script:PrivateTerms) {
        if ($Name.IndexOf($term,[StringComparison]::OrdinalIgnoreCase) -ge 0) { Add-Finding block 'private-file-name' $Name; break }
    }
    foreach ($pattern in $script:SecretPatterns.Values) {
        if ($Name -match $pattern) { Add-Finding block 'credential-in-file-name' $Name; break }
    }
    if ([regex]::IsMatch($Name,$script:EmailPattern)) { Add-Finding review 'email-in-file-name' $Name }
}

function Test-Identity {
    param([string]$Text, [string]$Location)
    $match = [regex]::Match($Text, '<([^>]*)>')
    if (-not $match.Success -or -not (Test-AllowedEmail $match.Groups[1].Value -Identity)) {
        Add-Finding block 'commit-email-not-approved' $Location
    }
    foreach ($term in $script:PrivateTerms) {
        if ($Text.IndexOf($term,[StringComparison]::OrdinalIgnoreCase) -ge 0) { Add-Finding block 'private-commit-identity' $Location; break }
    }
}

function Test-BinaryReview {
    param([byte[]]$Bytes, [string]$Location)
    $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
    if ($script:BinaryReviews.ContainsKey($sha)) { $script:ReviewedBinary++; return }
    Add-Finding review 'binary-needs-manual-review' $Location
}

function Test-Blob {
    param([byte[]]$Bytes, [string]$Location)
    $script:Scanned++
    if ($Bytes.Length -ge 4 -and $Bytes[0] -eq 80 -and $Bytes[1] -eq 75 -and $Bytes[2] -eq 3 -and $Bytes[3] -eq 4) {
        $stream = [IO.MemoryStream]::new($Bytes, $false)
        $archive = $null
        try {
            $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read)
            [long]$totalXml = 0
            foreach ($entry in $archive.Entries) {
                if ($entry.FullName -notmatch '\.(?:xml|rels)$') { continue }
                $totalXml += $entry.Length
                if ($totalXml -gt $script:MaxFileBytes) { Add-Finding review 'office-xml-size-limit' $Location; break }
                $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8, $true)
                try { $xml = [Net.WebUtility]::HtmlDecode($reader.ReadToEnd()) } finally { $reader.Dispose() }
                Test-Text $xml ($Location + ' [文档XML]')
                Test-Text ([regex]::Replace($xml,'<[^>]+>','')) ($Location + ' [文档文字]')
            }
        } catch { Add-Finding review 'archive-content-not-fully-read' $Location }
        finally { if ($null -ne $archive) { $archive.Dispose() }; $stream.Dispose() }
        Test-BinaryReview $Bytes $Location
        return
    }
    $text = $null
    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 255 -and $Bytes[1] -eq 254) { $text = [Text.Encoding]::Unicode.GetString($Bytes) }
    elseif ($Bytes.Length -ge 2 -and $Bytes[0] -eq 254 -and $Bytes[1] -eq 255) { $text = [Text.Encoding]::BigEndianUnicode.GetString($Bytes) }
    elseif ([Array]::IndexOf($Bytes,[byte]0) -lt 0) {
        try { $text = $script:Utf8.GetString($Bytes) } catch { $text = $null }
    }
    if ($null -eq $text -or ($Bytes.Length -ge 5 -and [Text.Encoding]::ASCII.GetString($Bytes,0,5) -eq '%PDF-')) {
        Test-BinaryReview $Bytes $Location
        return
    }
    Test-Text $text $Location
    if ($text -match '^version https://git-lfs.github.com/spec/v1\r?\n') {
        Add-Finding review 'lfs-payload-not-scanned' $Location
    }
}

try {
    $script:RepoPath = (Get-Item -LiteralPath $Repo).FullName
    $script:GitExecutable = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $inside = (Get-GitText @('rev-parse','--is-inside-work-tree')).Trim()
    $bare = (Get-GitText @('rev-parse','--is-bare-repository')).Trim()
    if ($inside -ne 'true' -and $bare -ne 'true') { throw 'NotRepository' }
    if ($Mode -ne 'History' -and $inside -ne 'true') { throw 'IndexRequiresWorktree' }
    if ($inside -eq 'true') { $script:RepoPath = [IO.Path]::GetFullPath((Get-GitText @('rev-parse','--show-toplevel')).Trim()) }

    $defaults = @{ allowedCommitEmails=@('294740142+WindFromKadath@users.noreply.github.com','github@github.com','noreply@github.com','dev@localhost','codex@localhost'); allowedPublicEmails=@(); reviewedBinaryFiles=@(); maxFileBytes=10485760 }
    if ($Policy) {
        $config = Get-Content -LiteralPath $Policy -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        foreach ($key in $config.Keys) { if (-not $defaults.ContainsKey($key)) { throw 'UnknownPolicyKey' }; $defaults[$key]=$config[$key] }
    }
    $script:MaxFileBytes = [long]$defaults.maxFileBytes
    if ($script:MaxFileBytes -lt 1 -or $script:MaxFileBytes -gt 104857600) { throw 'InvalidLimit' }
    $script:AllowedCommitEmails = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $script:AllowedPublicEmails = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($email in $defaults.allowedCommitEmails) { [void]$script:AllowedCommitEmails.Add([string]$email) }
    foreach ($email in $defaults.allowedPublicEmails) { [void]$script:AllowedPublicEmails.Add([string]$email) }
    foreach ($review in $defaults.reviewedBinaryFiles) {
        if ($review.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or -not $review.reason -or -not $review.reviewedOn) { throw 'IncompleteBinaryReview' }
        $script:BinaryReviews[$review.sha256.ToLowerInvariant()] = $true
    }
    $terms = @()
    if ($env:USERNAME -and $env:USERNAME.Length -ge 3) { $terms += $env:USERNAME }
    if ($env:PRIVACY_TERMS_FILE) {
        $localTerms = Get-Content -LiteralPath $env:PRIVACY_TERMS_FILE -Raw -Encoding UTF8 | ConvertFrom-Json -NoEnumerate
        if ($localTerms -isnot [array]) { throw 'LocalTermsMustBeArray' }
        foreach ($term in $localTerms) { if ($term -isnot [string] -or $term.Length -lt 3) { throw 'InvalidLocalTerm' }; $terms += $term }
    }
    foreach ($term in $terms) {
        foreach ($variant in @($term, [Uri]::EscapeDataString($term))) {
            if (-not $script:PrivateTerms.Contains($variant)) { $script:PrivateTerms.Add($variant) }
        }
    }
    $objects = @{}
    $catalog = @{}
    if ($Mode -eq 'History') {
        $allIds = @((Get-GitText @('rev-list','--objects','--all','--no-object-names')) -split '\r?\n' | Where-Object { $_ })
        if ($allIds.Count) {
            $inputData = [Text.Encoding]::ASCII.GetBytes(($allIds -join "`n") + "`n")
            $information = $script:Utf8.GetString((Get-GitBytes @('cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)') $inputData))
            foreach ($line in ($information -split '\r?\n' | Where-Object { $_ })) {
                $parts = $line -split ' '
                if ($parts.Count -ne 3) { throw 'IncompleteObjectRead' }
                if ($parts[1] -in @('blob','commit','tag')) { $objects[$parts[0]]=@{kind=$parts[1]; size=[long]$parts[2]; location=if($parts[1] -eq 'blob'){'历史文件版本'}else{'历史提交/标签元数据'}} }
            }
        }
        foreach ($ref in ((Get-GitText @('for-each-ref','--format=%(refname)')) -split '\r?\n' | Where-Object { $_ })) { Test-Text $ref '引用名称' }
        foreach ($commitId in ((Get-GitText @('rev-list','--all')) -split '\r?\n' | Where-Object { $_ })) {
            foreach ($entry in ((Get-GitText @('ls-tree','-rz',$commitId)) -split "`0" | Where-Object { $_ })) {
                $parts = $entry -split "`t",2
                $header = $parts[0] -split ' '
                Test-FileName $parts[1]
                if ($header[1] -eq 'commit') { Add-Finding review 'submodule-history-not-scanned' $parts[1] }
                elseif ($header[1] -eq 'blob') { $catalog[$header[2]]=$parts[1] }
            }
        }
        foreach ($id in @($objects.Keys)) { if ($catalog.ContainsKey($id)) { $objects[$id].location=$catalog[$id] } }
    } else {
        Test-Identity ((Get-GitText @('var','GIT_AUTHOR_IDENT')).Trim()) '实际作者署名'
        Test-Identity ((Get-GitText @('var','GIT_COMMITTER_IDENT')).Trim()) '实际提交者署名'
        $changed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        if ($Mode -eq 'Staged') {
            foreach ($name in ((Get-GitText @('diff','--cached','--name-only','--diff-filter=ACMR','--no-ext-diff','--no-textconv','-z')) -split "`0" | Where-Object { $_ })) { [void]$changed.Add($name) }
        }
        foreach ($entry in ((Get-GitText @('ls-files','--stage','-z')) -split "`0" | Where-Object { $_ })) {
            $parts = $entry -split "`t",2
            $header = $parts[0] -split ' '
            if ($header[2] -ne '0') { throw 'UnmergedIndex' }
            if ($Mode -eq 'Staged' -and -not $changed.Contains($parts[1])) { continue }
            Test-FileName $parts[1]
            if ($header[0] -eq '160000') { Add-Finding review 'submodule-not-scanned' $parts[1]; continue }
            $objects[$header[1]]=@{kind='blob'; size=[long](Get-GitText @('cat-file','-s',$header[1])).Trim(); location=$parts[1]}
        }
    }
    $readIds = @()
    foreach ($id in $objects.Keys) {
        if ($objects[$id].size -gt $script:MaxFileBytes) { Add-Finding review 'file-size-limit' $objects[$id].location }
        else { $readIds += $id }
    }
    if ($readIds.Count) {
        $batch = Get-GitBytes @('cat-file','--batch') ([Text.Encoding]::ASCII.GetBytes(($readIds -join "`n") + "`n"))
        $offset = 0
        while ($offset -lt $batch.Length) {
            $end = [Array]::IndexOf($batch,[byte]10,$offset)
            if ($end -lt 0) { throw 'IncompleteBatchHeader' }
            $header = [Text.Encoding]::ASCII.GetString($batch,$offset,$end-$offset) -split ' '
            if ($header.Count -ne 3) { throw 'IncompleteBatchRead' }
            $id=$header[0]; $kind=$header[1]; $size=[int]$header[2]
            $offset=$end+1
            if ($offset+$size -ge $batch.Length) { throw 'IncompleteBatchBody' }
            $bytes=[byte[]]::new($size)
            [Buffer]::BlockCopy($batch,$offset,$bytes,0,$size)
            $offset += $size+1
            $location=$objects[$id].location
            if ($kind -eq 'blob') { Test-Blob $bytes $location }
            else {
                $text=$script:Utf8.GetString($bytes)
                foreach ($line in (($text -split "`n`n",2)[0] -split "`n")) {
                    if ($line -match '^(?:author|committer|tagger) ') { Test-Identity $line $location }
                }
                Test-Text $text $location
            }
        }
    }
    if ($CommitMessagePath) {
        Test-Text (Get-Content -LiteralPath $CommitMessagePath -Raw -Encoding UTF8) '本次提交说明'
    }
    $blocked = @($script:Findings | Where-Object level -eq 'block').Count
    $manual = @($script:Findings | Where-Object level -eq 'review').Count
    $code = if($blocked){1}elseif($manual){2}else{0}
    $report = [ordered]@{ checkedAtUtc=[DateTime]::UtcNow.ToString('o'); mode=$Mode; fileVersionsScanned=$script:Scanned; binaryVersionsWithPriorReview=$script:ReviewedBinary; blockingFindings=$blocked; manualReviewFindings=$manual; exitCode=$code; findings=$script:Findings.ToArray(); limits=@('No image OCR or PDF text extraction','No complete archive, LFS or submodule scan','Local reachable refs only; no remote GitHub metadata or caches','Pattern based candidates; not proof of absence') }
    if ($ReportPath) {
        $reportTarget=[IO.Path]::GetFullPath($ReportPath)
        $repoPrefix=$script:RepoPath.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        if ($reportTarget.StartsWith($repoPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'KeepReportsOutsideRepository' }
        [IO.File]::WriteAllText($reportTarget, ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    }
    Write-Output "隐私检查：模式=$Mode，检查文件版本=$script:Scanned，阻断项=$blocked，待人工确认项=$manual，已记录二进制审查=$script:ReviewedBinary。"
    foreach ($finding in $script:Findings) {
        Write-Output ('[{0}] {1} | {2} | 行 {3}' -f $finding.level,$finding.rule,$finding.location,$finding.line)
    }
    Write-Output '结果仅覆盖本次自动检查范围；请完成文档、图片、数据及上传后的人工核验。'
    exit $code
} catch {
    Write-Output '检查未完成：请确认 PowerShell 7、Git 仓库、署名配置和规则文件均有效。未输出敏感原文；此结果不能作为通过。'
    exit 3
}
