require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

const TOKEN = process.env.WIALON_TOKEN || '38d7318f04f9084e413bb027d54e43d5FBB4EE33A40D6819959DC2E9BFCE80A3027A6205';
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'singh_brothers_apikey_1122';

let sessionId = null;

async function getSession() {
  if (sessionId) return sessionId;

  const response = await axios.get(WIALON_URL, {
    params: {
      svc: 'token/login',
      params: JSON.stringify({ token: TOKEN })
    }
  });

  if (response.data.error) {
    throw new Error(`Wialon login failed. Error code: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

function parseMetric(val) {
  if (!val) return 0;
  const raw = typeof val === 'object' ? val.t : val;
  const cleaned = String(raw).replace(/[^\d.-]/g, '');
  return parseFloat(cleaned) || 0;
}

function parseDurationToHours(timeStr) {
  const raw = typeof timeStr === 'object' ? timeStr.t : timeStr;
  if (!raw) return 0;
  if (String(raw).includes(':')) {
    const parts = String(raw).split(':').map(Number);
    const hours = parts[0] || 0;
    const minutes = parts[1] || 0;
    const seconds = parts[2] || 0;
    return +(hours + minutes / 60 + seconds / 3600).toFixed(2);
  }
  return parseFloat(raw) || 0;
}

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Singh Brothers Operational Fleet API'
  });
});

// 1. Live Vehicles Tracking Endpoint
app.get('/api/vehicles', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 0;
  const searchMask = req.query.search ? `*${req.query.search}*` : '*';
  const from = limit > 0 ? (page - 1) * limit : 0;
  const to = limit > 0 ? from + limit - 1 : 0;

  try {
    let eid = await getSession();

    const searchParams = {
      spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: searchMask, sortType: 'sys_name' },
      force: 1,
      flags: 1025,
      from,
      to
    };

    let result = await axios.get(WIALON_URL, {
      params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
    });

    if (result.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      result = await axios.get(WIALON_URL, {
        params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
      });
    }

    const vehicles = (result.data.items || []).map((unit) => ({
      unitId: unit.id,
      unitName: unit.nm,
      latitude: unit.pos ? unit.pos.y : null,
      longitude: unit.pos ? unit.pos.x : null,
      speedKmh: unit.pos ? unit.pos.s : 0,
      heading: unit.pos ? unit.pos.c : 0,
      lastSeen: unit.pos ? new Date(unit.pos.t * 1000).toISOString() : null
    }));

    res.json({
      status: 'success',
      totalCount: result.data.totalItemsCount || vehicles.length,
      returnedCount: vehicles.length,
      data: vehicles
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. Operational Report Endpoint (Template 5 Mapped)
app.get('/api/reports/summary', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  const resourceId = parseInt(req.query.resourceId) || 29094703;
  const templateId = parseInt(req.query.templateId) || 5;
  const objectId = parseInt(req.query.objectId) || 29094722;

  // Dynamic "Today" Calculation in IST (UTC+5:30)
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);

  const istMidnight = new Date(Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    0, 0, 0
  ));

  const defaultFrom = Math.floor((istMidnight.getTime() - istOffsetMs) / 1000);
  const defaultTo = Math.floor(Date.now() / 1000);

  const from = parseInt(req.query.from) || defaultFrom;
  const to = parseInt(req.query.to) || defaultTo;

  try {
    let eid = await getSession();

    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      interval: {
        from: from,
        to: to,
        flags: 16777216
      }
    };

    let execRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/exec_report', params: JSON.stringify(execParams), sid: eid }
    });

    if (execRes.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      execRes = await axios.get(WIALON_URL, {
        params: { svc: 'report/exec_report', params: JSON.stringify(execParams), sid: eid }
      });
    }

    if (execRes.data.error) {
      return res.status(400).json({ error: `Wialon exec_report error: ${execRes.data.error}` });
    }

    const reportTables = execRes.data.reportResult?.tables || [];
    if (reportTables.length === 0) {
      await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });
      return res.json({
        status: 'empty',
        message: 'No report data found for this interval.',
        data: []
      });
    }

    const rowParams = {
      tableIndex: 0,
      config: {
        type: 'range',
        data: { from: 0, to: 1000, level: 0 }
      }
    };

    const rowsRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
    });

    await axios.get(WIALON_URL, {
      params: { svc: 'report/cleanup_result', params: '{}', sid: eid }
    });

    const rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

    // Map Template 5 headers into structured, typed keys
    const fleetData = rawRows.map((row, idx) => {
      const cols = (row.c || []).map((c) => (typeof c === 'object' ? c.t : c));
      return {
        index: idx + 1,
        vehicleName: cols[0] || 'Unknown Unit',
        distanceKm: parseMetric(cols[1]),
        engineHoursDecimal: parseDurationToHours(cols[2]),
        fuelConsumedLiters: parseMetric(cols[3]),
        mileageKmpl: parseMetric(cols[4]),
        refuelingLiters: parseMetric(cols[5]),
        unaccountedDrainLiters: parseMetric(cols[6])
      };
    });

    res.json({
      status: 'success',
      reportMeta: {
        resourceId,
        templateId,
        objectId,
        headers: reportTables[0]?.header || []
      },
      period: {
        fromTimestamp: from,
        toTimestamp: to,
        fromDate: new Date(from * 1000).toISOString(),
        toDate: new Date(to * 1000).toISOString()
      },
      totalVehicles: fleetData.length,
      data: fleetData
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Singh Brothers API running on port ${PORT}`);
});
