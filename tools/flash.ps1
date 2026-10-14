<#
.SYNOPSIS
    Compile and flash the v2 firmware and web UI to the ESP32 DevKit.

.DESCRIPTION
    Builds with the esp32 profile in code/WebTurntable/sketch.yaml, so the pinned
    core and libraries are used. Finds arduino-cli on PATH, or the copy bundled
    with Arduino IDE 2. Step-by-step instructions are in docs/FLASHING.md.

    Actions:
      check     Compile only (the default).
      firmware  Compile and upload the firmware.
      webui     Build the web UI image from data/ and upload it.
      all       firmware, then webui.
      monitor   Open the serial monitor. Press Ctrl+C to exit.
      ports     List serial ports.

    Add -WhatIf to see what would be uploaded without writing to the board.

.EXAMPLE
    tools\flash.cmd all

.EXAMPLE
    tools\flash.cmd webui -Port COM7
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Position = 0)]
    [ValidateSet('check', 'firmware', 'webui', 'all', 'monitor', 'ports')]
    [string]$Action = 'check',

    # Serial port such as COM7. Detected automatically when one USB serial device is plugged in.
    [string]$Port,

    # Serial monitor speed; the v2 firmware logs at 115200.
    [int]$Baud = 115200,

    # Sketch folder (default code\WebTurntable). Only changed when testing this script.
    [string]$Sketch
)

$ErrorActionPreference = 'Stop'
$BuildProfile = 'esp32'

# Windows PowerShell 5.1 has no $PSScriptRoot while defaults are bound, so resolve it here.
if (-not $Sketch) {
    $Sketch = Join-Path (Split-Path -Parent $PSScriptRoot) 'code\WebTurntable'
}

# USB vendor IDs of the USB-to-serial chips used on ESP32 boards.
$KnownUsbVendors = @{
    '0x10C4' = 'CP210x'
    '0x1A86' = 'CH340'
    '0x0403' = 'FTDI'
    '0x303A' = 'Espressif'
}

# Print a step heading so long tool output is easy to follow.
function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# Find arduino-cli on PATH, or the copy bundled with Arduino IDE 2.
function Find-ArduinoCli {
    $onPath = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }
    $bundled = 'resources\app\lib\backend\resources\arduino-cli.exe'
    foreach ($ideDir in @((Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE'), (Join-Path $env:ProgramFiles 'Arduino IDE'))) {
        $candidate = Join-Path $ideDir $bundled
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    throw 'arduino-cli not found. Install Arduino IDE 2, or put arduino-cli on PATH.'
}

# Run arduino-cli and stop the script if it fails.
function Invoke-ArduinoCli([string[]]$Arguments) {
    & $script:Cli @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "arduino-cli $($Arguments[0]) failed (exit code $LASTEXITCODE)."
    }
}

# Read the profile's build properties: tool paths, partition scheme, upload speed.
function Get-BuildProperties {
    $lines = & $script:Cli compile --profile $BuildProfile --show-properties $Sketch
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not read the build properties from arduino-cli.'
    }
    $props = @{}
    foreach ($line in $lines) {
        $i = $line.IndexOf('=')
        if ($i -gt 0) {
            $props[$line.Substring(0, $i)] = $line.Substring($i + 1)
        }
    }
    return $props
}

# Parse a partition table number: 0x hex, plain decimal, or a K/M suffix.
function ConvertFrom-PartitionNumber([string]$Text) {
    if ($Text -match '^0x([0-9a-f]+)$') {
        return [Convert]::ToInt64($Matches[1], 16)
    }
    if ($Text -match '^(\d+)([KM]?)$') {
        $scale = @{ '' = 1; 'K' = 1KB; 'M' = 1MB }[$Matches[2].ToUpper()]
        return [int64]$Matches[1] * $scale
    }
    throw "Unreadable partition table value '$Text'."
}

# Offset and size of the file system partition. A partitions.csv in the sketch
# folder overrides the core's table, the same way the build treats it.
function Get-FileSystemPartition($Props) {
    $table = Join-Path $Sketch 'partitions.csv'
    if (-not (Test-Path $table)) {
        $table = Join-Path $Props['runtime.platform.path'] "tools\partitions\$($Props['build.partitions']).csv"
    }
    foreach ($line in Get-Content $table) {
        $fields = @(($line -replace '#.*$', '').Split(',') | ForEach-Object { $_.Trim() })
        if ($fields.Count -ge 5 -and $fields[1] -eq 'data' -and $fields[2] -in @('spiffs', 'littlefs')) {
            if (-not $fields[3]) {
                throw "The file system partition in $table needs an explicit offset."
            }
            return @{
                Offset = ConvertFrom-PartitionNumber $fields[3]
                Size   = ConvertFrom-PartitionNumber $fields[4]
            }
        }
    }
    throw "No spiffs or littlefs partition found in $table."
}

# Serial ports reported by arduino-cli, marking USB ones and known ESP32 USB chips.
function Get-SerialPorts {
    $json = (& $script:Cli board list --format json) -join "`n" | ConvertFrom-Json
    if ($json -and $json.PSObject.Properties.Name -contains 'detected_ports') {
        $json = $json.detected_ports
    }
    foreach ($entry in @($json)) {
        $p = $entry.port
        if (-not $p -or $p.protocol -ne 'serial') {
            continue
        }
        $vid = $null
        if ($p.properties) {
            $vid = $p.properties.vid
        }
        $chip = $null
        if ($vid) {
            $chip = $KnownUsbVendors[$vid]
        }
        [pscustomobject]@{
            Port  = $p.address
            Usb   = [bool]$vid
            Chip  = $chip
            Label = $p.protocol_label
        }
    }
}

# Use -Port if given. Otherwise pick the single USB serial port, preferring known
# ESP32 USB chips. Bluetooth and built-in COM ports are never picked.
function Resolve-Port {
    if ($Port) {
        return $Port
    }
    $usb = @(Get-SerialPorts | Where-Object { $_.Usb })
    $known = @($usb | Where-Object { $_.Chip })
    if ($known.Count -eq 1) {
        $pick = $known[0]
    } elseif ($known.Count -eq 0 -and $usb.Count -eq 1) {
        $pick = $usb[0]
    } elseif ($usb.Count -eq 0) {
        if ($WhatIfPreference) {
            return 'COM?'
        }
        throw ('No USB serial port found. Plug in the DevKit with a USB data cable (some cables only charge). ' +
            'If Windows does not show a new COM port, install the USB driver (docs/FLASHING.md). Or pass -Port COMx.')
    } else {
        $names = ($usb | ForEach-Object { $_.Port }) -join ', '
        throw "Several USB serial ports found ($names). Pick one with -Port, for example: tools\flash.cmd $Action -Port $($usb[0].Port)"
    }
    Write-Step "Using $($pick.Port) ($($pick.Label))"
    return $pick.Port
}

# Compile only, to check the firmware builds with the pinned versions.
function Invoke-Check {
    Write-Step "Compiling $Sketch (profile $BuildProfile)"
    Invoke-ArduinoCli @('compile', '--profile', $BuildProfile, $Sketch)
}

# Compile, then upload the firmware (bootloader, partition table and app).
function Invoke-Firmware([string]$Target) {
    if ($PSCmdlet.ShouldProcess($Target, 'Upload firmware')) {
        Write-Step "Compiling and uploading firmware to $Target"
        Invoke-ArduinoCli @('compile', '--profile', $BuildProfile, '--upload', '--port', $Target, $Sketch)
    } else {
        Invoke-Check
    }
}

# Pack data/ into a LittleFS image sized to the partition, then write it with esptool.
function Invoke-WebUi([string]$Target) {
    $props = Get-BuildProperties
    $partition = Get-FileSystemPartition $props
    $mklittlefs = Join-Path $props['runtime.tools.mklittlefs.path'] 'mklittlefs.exe'
    $esptool = Join-Path $props['runtime.tools.esptool_py.path'] $props['tools.esptool_py.cmd']
    $data = Join-Path $Sketch 'data'
    $image = Join-Path ([IO.Path]::GetTempPath()) 'webturntable-littlefs.bin'
    $offset = '0x{0:X}' -f $partition.Offset

    if (-not (Test-Path $data -PathType Container)) {
        throw "No web UI folder at $data."
    }
    $files = @(Get-ChildItem $data -File -Recurse)
    $bytes = ($files | Measure-Object Length -Sum).Sum
    Write-Step ('Building web UI image: {0} files, {1:N1} KB, for the {2:N0} KB partition at {3}' -f $files.Count, ($bytes / 1KB), ($partition.Size / 1KB), $offset)
    & $mklittlefs -c $data -p 256 -b 4096 -s $partition.Size $image
    if ($LASTEXITCODE -ne 0) {
        throw 'mklittlefs failed. Check that the web UI fits in the partition.'
    }

    if ($PSCmdlet.ShouldProcess($Target, "Write web UI image to $offset")) {
        Write-Step "Uploading web UI to $Target"
        & $esptool --chip $props['build.mcu'] --port $Target --baud $props['upload.speed'] --before default-reset --after hard-reset write-flash -z $offset $image
        if ($LASTEXITCODE -ne 0) {
            throw 'esptool could not write the web UI. See Troubleshooting in docs/FLASHING.md.'
        }
    }
}

try {
    $script:Cli = Find-ArduinoCli

    switch ($Action) {
        'check' {
            Invoke-Check
        }
        'firmware' {
            Invoke-Firmware (Resolve-Port)
        }
        'webui' {
            Invoke-WebUi (Resolve-Port)
        }
        'all' {
            $target = Resolve-Port
            Invoke-Firmware $target
            Invoke-WebUi $target
            Write-Step 'Done. Join the TURNTABLE Wi-Fi network and open http://192.168.4.1'
        }
        'monitor' {
            $target = Resolve-Port
            Write-Step "Serial monitor on $target at $Baud baud. Press Ctrl+C to exit."
            Invoke-ArduinoCli @('monitor', '--port', $target, '--config', "baudrate=$Baud")
        }
        'ports' {
            Get-SerialPorts | Format-Table Port, Usb, Chip, Label -AutoSize
        }
    }
} catch {
    # Show just the message; the script's own errors already say what to do next.
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
