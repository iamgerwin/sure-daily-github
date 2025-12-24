# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2025-12-24

### Added
- **Systemd Service**: Professional service unit file for automatic process management
  - Auto-restart on crash with 10-second delay
  - Memory limit enforcement (512MB)
  - Boot-time persistence
  - Comprehensive logging to systemd.log
  - Resource limit controls

- **Health Monitoring**: Automated health check system
  - Cron-based monitoring (runs every 30 minutes)
  - Automatic service restart on failure detection
  - Health status logging
  - Process hang detection and recovery

- **Verification Tools**: Management and diagnostics scripts
  - `scripts/verify-status.sh`: Quick status check with health diagnostics
  - Service state verification
  - Memory and CPU usage monitoring
  - Recent activity tracking
  - Configuration display

- **Documentation**: Comprehensive setup and troubleshooting guide
  - `docs/SCHEDULER_SETUP.md`: Complete 177-line guide including:
    - Systemd service configuration details
    - Health monitoring mechanism explanation
    - Troubleshooting procedures
    - Recovery instructions
    - Service management commands
    - Log viewing examples
    - FAQ and common issues

### Fixed
- Resolved recurring issue of scheduler process hanging without restart mechanism
- Fixed missing days of GitHub contributions due to service outages
- Improved system reliability with multi-layered monitoring
- Enhanced diagnostics and recovery procedures

### Changed
- Updated `deployment/sure-daily-github.service` with improved configuration
- Enhanced process management with memory limits and restart policies

## [1.0.0] - Initial Release

### Added
- Initial project setup with Node.js-based automation
- Cron-based scheduling support
- GitHub API integration
- Configuration management system
- State tracking for issue and commit tracking
- Support for multiple repositories
- Timezone-aware scheduling
- Dry-run mode for testing
- Comprehensive README and setup documentation

[1.5.1]: https://github.com/iamgerwin/sure-daily-github/compare/v1.0.0...v1.5.1
[1.0.0]: https://github.com/iamgerwin/sure-daily-github/releases/tag/v1.0.0
