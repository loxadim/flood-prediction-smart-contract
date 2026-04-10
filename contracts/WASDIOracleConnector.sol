// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IWASDIOracle.sol";

/**
 * @title WASDIOracleConnector
 * @author DPA Foundation — OPAL Platform
 * @notice Production-grade connector to WASDI (Web Advanced Space Developer Interface)
 *         satellite data feed via authorized off-chain relayer
 * @dev Implements IWASDIOracle with:
 *      - Authorized relayer whitelist
 *      - Configurable data freshness threshold
 *      - Region-level satellite data storage
 *      - Multi-source satellite support (Sentinel-1/2, MODIS, Landsat)
 *      - Anomaly detection (sudden risk spikes)
 *      - Historical data retention for audit
 *
 * Architecture:
 * ┌──────────┐   WASDI API   ┌──────────────┐   submitData  ┌─────────────────────┐
 * │  WASDI   │ ────────────▶ │  Off-Chain   │ ─────────────▶│WASDIOracleConnector │
 * │ Platform │               │  Relayer     │               │(this contract)      │
 * └──────────┘               └──────────────┘               └────────┬────────────┘
 *                                                                    │
 *                            ┌──────────────┐    getRiskScore┌───────▼──────────┐
 *                            │  FloodPred   │ ◀──────────────│  MultiOracle     │
 *                            │  Contract    │                │  (consensus)     │
 *                            └──────────────┘                └──────────────────┘
 */
contract WASDIOracleConnector is IWASDIOracle, Ownable2Step, Pausable, ReentrancyGuard {

    // ============================
    // Constants
    // ============================
    uint256 public constant MAX_RISK_SCORE = 100;
    uint256 public constant MAX_RAINFALL = 2000;        // 2000mm max reasonable rainfall
    uint256 public constant MAX_SOIL_MOISTURE = 100;
    uint256 public constant MAX_WATER_LEVEL = 10000;    // 100m max water level (in cm)
    uint256 public constant MIN_FRESHNESS = 30 minutes;
    uint256 public constant MAX_FRESHNESS = 7 days;
    uint256 public constant MAX_HISTORY_ENTRIES = 100;   // Per region
    uint256 public constant ANOMALY_THRESHOLD = 40;      // Risk spike > 40 points triggers anomaly

    // ============================
    // State Variables
    // ============================
    
    /// @notice Data freshness threshold (default 6 hours)
    uint256 private _freshnessThreshold;
    
    /// @notice Latest satellite data per region
    mapping(string => SatelliteData) private _latestData;
    
    /// @notice Historical data per region (circular buffer)
    mapping(string => SatelliteData[]) private _history;
    
    /// @notice Authorized relayer addresses
    mapping(address => bool) public authorizedRelayers;
    
    /// @notice Supported satellite sources
    mapping(string => bool) public supportedSources;
    
    /// @notice Total submissions count
    uint256 public totalSubmissions;
    
    /// @notice Region submission counts
    mapping(string => uint256) public regionSubmissions;
    
    /// @notice Last anomaly per region
    mapping(string => uint256) public lastAnomalyTimestamp;

    /// @notice Test mode flag — simulation functions only available when enabled (I-03 fix)
    bool public testMode;

    /// @notice H-06 fix: once locked, testMode cannot be re-enabled
    bool public productionLocked;

    /// @notice V-06 fix: configurable risk alert threshold (default 70)
    uint256 public riskAlertThreshold;

    /// @notice H-05 fix: Track number of authorized relayers
    uint256 public relayerCount;

    // ============================
    // Errors
    // ============================
    error UnauthorizedRelayer();
    error InvalidRiskScore(uint256 score);
    error InvalidRainfall(uint256 rainfall);
    error InvalidSoilMoisture(uint256 moisture);
    error InvalidWaterLevel(uint256 level);
    error EmptyRegion();
    error UnsupportedSatelliteSource(string source);
    error InvalidFreshnessThreshold(uint256 threshold);
    error DataTooOld(string region, uint256 lastUpdate);
    error ZeroAddress();
    error RelayerAlreadyAuthorized(address relayer);
    error RelayerNotAuthorized(address relayer);
    error TestModeNotEnabled();
    error CannotRemoveLastRelayer();

    // ============================
    // Events
    // ============================
    event RelayerAdded(address indexed relayer);
    event RelayerRemoved(address indexed relayer);
    event SatelliteSourceAdded(string source);
    event SatelliteSourceRemoved(string source);
    event FreshnessThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event AnomalyDetected(string indexed region, uint256 previousRisk, uint256 newRisk, uint256 timestamp);
    event TestModeChanged(bool enabled);
    event ProductionModeLocked();

    // ============================
    // Modifiers
    // ============================
    modifier onlyRelayer() {
        if (!authorizedRelayers[msg.sender]) revert UnauthorizedRelayer();
        _;
    }

    // ============================
    // Constructor
    // ============================
    constructor() Ownable(msg.sender) {
        _freshnessThreshold = 6 hours;
        testMode = false; // C-02 fix: disabled by default for production safety
        riskAlertThreshold = 70; // V-06 fix: configurable, default 70
        
        // Register default supported satellite sources
        supportedSources["Sentinel-1"] = true;
        supportedSources["Sentinel-2"] = true;
        supportedSources["MODIS"] = true;
        supportedSources["Landsat-8"] = true;
        supportedSources["Landsat-9"] = true;
        supportedSources["VIIRS"] = true;
        
        // Owner is first authorized relayer
        authorizedRelayers[msg.sender] = true;
        relayerCount = 1;
        emit RelayerAdded(msg.sender);
    }

    // ============================
    // Core Data Submission
    // ============================

    /**
     * @inheritdoc IWASDIOracle
     */
    function submitSatelliteData(
        string calldata region,
        uint256 riskScore,
        uint256 rainfall,
        uint256 soilMoisture,
        uint256 waterLevel,
        string calldata satelliteSource
    ) external override onlyRelayer whenNotPaused nonReentrant {
        // Validate inputs
        if (bytes(region).length == 0) revert EmptyRegion();
        if (riskScore > MAX_RISK_SCORE) revert InvalidRiskScore(riskScore);
        if (rainfall > MAX_RAINFALL) revert InvalidRainfall(rainfall);
        if (soilMoisture > MAX_SOIL_MOISTURE) revert InvalidSoilMoisture(soilMoisture);
        if (waterLevel > MAX_WATER_LEVEL) revert InvalidWaterLevel(waterLevel);
        if (!supportedSources[satelliteSource]) revert UnsupportedSatelliteSource(satelliteSource);

        // M-09 fix: bidirectional anomaly detection (both spikes and drops)
        SatelliteData storage previous = _latestData[region];
        if (previous.isProcessed) {
            uint256 diff = riskScore > previous.riskScore 
                ? riskScore - previous.riskScore 
                : previous.riskScore - riskScore;
            if (diff > ANOMALY_THRESHOLD) {
                lastAnomalyTimestamp[region] = block.timestamp;
                emit AnomalyDetected(region, previous.riskScore, riskScore, block.timestamp);
            }
        }

        // Store data
        SatelliteData memory newData = SatelliteData({
            region: region,
            riskScore: riskScore,
            rainfall: rainfall,
            soilMoisture: soilMoisture,
            waterLevel: waterLevel,
            timestamp: block.timestamp,
            satelliteSource: satelliteSource,
            isProcessed: true
        });

        _latestData[region] = newData;

        // Maintain history (circular buffer)
        if (_history[region].length < MAX_HISTORY_ENTRIES) {
            _history[region].push(newData);
        } else {
            uint256 idx = regionSubmissions[region] % MAX_HISTORY_ENTRIES;
            _history[region][idx] = newData;
        }

        totalSubmissions++;
        regionSubmissions[region]++;

        emit SatelliteDataSubmitted(region, riskScore, rainfall, satelliteSource);
        
        if (riskScore >= riskAlertThreshold) {
            emit HighRiskDetected(region, riskScore, block.timestamp);
        }
    }

    // ============================
    // View Functions
    // ============================

    /**
     * @inheritdoc IWASDIOracle
     */
    function getLatestData(string calldata region) external view override returns (SatelliteData memory) {
        return _latestData[region];
    }

    /**
     * @inheritdoc IWASDIOracle
     */
    function getRiskScore(string calldata region) external view override returns (uint256) {
        SatelliteData storage data = _latestData[region];
        if (!data.isProcessed) return 0;
        if (block.timestamp - data.timestamp > _freshnessThreshold) return 0;
        return data.riskScore;
    }

    /**
     * @inheritdoc IWASDIOracle
     */
    function isDataFresh(string calldata region) external view override returns (bool) {
        SatelliteData storage data = _latestData[region];
        if (!data.isProcessed) return false;
        return block.timestamp - data.timestamp <= _freshnessThreshold;
    }

    /**
     * @inheritdoc IWASDIOracle
     */
    function getDataFreshnessThreshold() external view override returns (uint256) {
        return _freshnessThreshold;
    }

    /**
     * @notice Get historical data for a region
     * @dev Returns entries in chronological order (oldest first).
     *      Uses a circular buffer internally. When the buffer has not yet wrapped
     *      (len < MAX_HISTORY_ENTRIES) entries are sequential. After wrap the write
     *      head is at regionSubmissions[region] % MAX_HISTORY_ENTRIES and the oldest
     *      entry is one slot ahead of it.
     * @param region Region code
     * @param count Number of recent entries to return
     * @return Array of historical satellite data in chronological order
     */
    function getHistoricalData(
        string calldata region,
        uint256 count
    ) external view returns (SatelliteData[] memory) {
        SatelliteData[] storage history = _history[region];
        uint256 len = history.length;
        if (len == 0 || count == 0) return new SatelliteData[](0);
        if (count > len) count = len;

        SatelliteData[] memory result = new SatelliteData[](count);

        if (len < MAX_HISTORY_ENTRIES) {
            // M-WASDI-1 fix: buffer not yet wrapped — simple linear slice from the end
            uint256 start = len - count;
            for (uint256 i = 0; i < count; i++) {
                result[i] = history[start + i];
            }
        } else {
            // Buffer has wrapped. The write head (next write position) is at
            // regionSubmissions[region] % MAX_HISTORY_ENTRIES, so the newest entry is
            // one slot before the head (wrapping around).
            uint256 head = regionSubmissions[region] % MAX_HISTORY_ENTRIES; // next write slot = oldest slot
            // Start of our window (count entries back from the newest)
            uint256 start = (head + MAX_HISTORY_ENTRIES - count) % MAX_HISTORY_ENTRIES;
            for (uint256 i = 0; i < count; i++) {
                result[i] = history[(start + i) % MAX_HISTORY_ENTRIES];
            }
        }
        return result;
    }

    /**
     * @notice Calculate average risk score for a region over recent submissions
     * @dev M-WASDI-2 fix: only includes fresh (non-stale) entries to prevent
     *      stale satellite data from skewing the average.
     * @param region Region code
     * @param period Max number of recent submissions to consider
     * @return Average risk score (0 if no fresh data)
     */
    function getAverageRisk(string calldata region, uint256 period) external view returns (uint256) {
        SatelliteData[] storage history = _history[region];
        uint256 len = history.length;
        if (len == 0 || period == 0) return 0;
        if (period > len) period = len;

        uint256 total;
        uint256 freshCount;

        if (len < MAX_HISTORY_ENTRIES) {
            uint256 start = len - period;
            for (uint256 i = start; i < len; i++) {
                if (block.timestamp - history[i].timestamp <= _freshnessThreshold) {
                    total += history[i].riskScore;
                    freshCount++;
                }
            }
        } else {
            uint256 head = regionSubmissions[region] % MAX_HISTORY_ENTRIES;
            uint256 start = (head + MAX_HISTORY_ENTRIES - period) % MAX_HISTORY_ENTRIES;
            for (uint256 i = 0; i < period; i++) {
                SatelliteData storage entry = history[(start + i) % MAX_HISTORY_ENTRIES];
                if (block.timestamp - entry.timestamp <= _freshnessThreshold) {
                    total += entry.riskScore;
                    freshCount++;
                }
            }
        }

        if (freshCount == 0) return 0;
        return total / freshCount;
    }

    /**
     * @notice Check if anomaly was recently detected for a region
     * @param region Region code
     * @param window Time window in seconds
     */
    function hasRecentAnomaly(string calldata region, uint256 window) external view returns (bool) {
        uint256 last = lastAnomalyTimestamp[region];
        if (last == 0) return false;
        return block.timestamp - last <= window;
    }

    // ============================
    // Simulation (Testing)
    // ============================

    /**
     * @inheritdoc IWASDIOracle
     * @dev Only available when testMode is enabled. Disable before mainnet deployment.
     */
    function simulateHighRisk(string calldata region) external override onlyRelayer {
        if (!testMode) revert TestModeNotEnabled();
        SatelliteData memory newData = SatelliteData({
            region: region,
            riskScore: 90,
            rainfall: 150,
            soilMoisture: 85,
            waterLevel: 250,
            timestamp: block.timestamp,
            satelliteSource: "Sentinel-1",
            isProcessed: true
        });
        _latestData[region] = newData;

        // V-05 fix: write to circular buffer before incrementing counter
        if (_history[region].length < MAX_HISTORY_ENTRIES) {
            _history[region].push(newData);
        } else {
            uint256 idx = regionSubmissions[region] % MAX_HISTORY_ENTRIES;
            _history[region][idx] = newData;
        }
        
        totalSubmissions++;
        regionSubmissions[region]++;
        
        emit SatelliteDataSubmitted(region, 90, 150, "Sentinel-1");
        emit HighRiskDetected(region, 90, block.timestamp);
    }

    /**
     * @inheritdoc IWASDIOracle
     * @dev Only available when testMode is enabled. Disable before mainnet deployment.
     */
    function simulateLowRisk(string calldata region) external override onlyRelayer {
        if (!testMode) revert TestModeNotEnabled();
        SatelliteData memory newData = SatelliteData({
            region: region,
            riskScore: 15,
            rainfall: 5,
            soilMoisture: 30,
            waterLevel: 10,
            timestamp: block.timestamp,
            satelliteSource: "Sentinel-2",
            isProcessed: true
        });
        _latestData[region] = newData;

        // V-05 fix: write to circular buffer before incrementing counter
        if (_history[region].length < MAX_HISTORY_ENTRIES) {
            _history[region].push(newData);
        } else {
            uint256 idx = regionSubmissions[region] % MAX_HISTORY_ENTRIES;
            _history[region][idx] = newData;
        }
        
        totalSubmissions++;
        regionSubmissions[region]++;
        
        emit SatelliteDataSubmitted(region, 15, 5, "Sentinel-2");
    }

    // ============================
    // Admin Functions
    // ============================

    /**
     * @notice Add an authorized relayer
     */
    function addRelayer(address relayer) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        if (authorizedRelayers[relayer]) revert RelayerAlreadyAuthorized(relayer);
        authorizedRelayers[relayer] = true;
        relayerCount++;
        emit RelayerAdded(relayer);
    }

    /**
     * @notice Remove an authorized relayer
     */
    function removeRelayer(address relayer) external onlyOwner {
        if (!authorizedRelayers[relayer]) revert RelayerNotAuthorized(relayer);
        if (relayerCount <= 1) revert CannotRemoveLastRelayer();
        authorizedRelayers[relayer] = false;
        relayerCount--;
        emit RelayerRemoved(relayer);
    }

    /**
     * @notice Add a supported satellite source
     */
    function addSatelliteSource(string calldata source) external onlyOwner {
        supportedSources[source] = true;
        emit SatelliteSourceAdded(source);
    }

    /**
     * @notice Remove a satellite source
     */
    function removeSatelliteSource(string calldata source) external onlyOwner {
        supportedSources[source] = false;
        emit SatelliteSourceRemoved(source);
    }

    /**
     * @notice Update the data freshness threshold
     */
    function setFreshnessThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold < MIN_FRESHNESS || newThreshold > MAX_FRESHNESS) {
            revert InvalidFreshnessThreshold(newThreshold);
        }
        uint256 oldThreshold = _freshnessThreshold;
        _freshnessThreshold = newThreshold;
        emit FreshnessThresholdUpdated(oldThreshold, newThreshold);
    }

    /**
     * @notice Enable or disable test mode (controls simulation function access)
     * @param enabled True to enable test mode, false to disable
     */
    function setTestMode(bool enabled) external onlyOwner {
        // H-06 fix: cannot re-enable test mode once production is locked
        if (productionLocked && enabled) revert TestModeNotEnabled();
        testMode = enabled;
        emit TestModeChanged(enabled);
    }

    /**
     * @notice Irreversibly lock production mode — test mode can never be re-enabled
     */
    function lockProductionMode() external onlyOwner {
        testMode = false;
        productionLocked = true;
        emit ProductionModeLocked();
    }

    /**
     * @notice Pause the oracle (emergency)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the oracle
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice V-06 fix: Update the risk alert threshold for HighRiskDetected emission
     * @param newThreshold New threshold value (1-100)
     */
    function setRiskAlertThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold == 0 || newThreshold > MAX_RISK_SCORE) revert InvalidRiskScore(newThreshold);
        riskAlertThreshold = newThreshold;
    }
}
