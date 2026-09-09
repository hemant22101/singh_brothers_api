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
    throw new Error(`Wialon login failed with code: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

// Service Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Singh Brothers Operational Fleet API'
  });
});

// 1. Live Vehicles
app.get('/api/vehicles', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  const searchMask = req.query.search ? `*${req.query.search}*` : '*';

  try {
    let eid = await getSession();

    const searchParams = {
      spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: searchMask, sortType: 'sys_name' },
      force: 1,
      flags: 1025,
      from: 0,
      to: 0
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
      totalCount: vehicles.length,
      data: vehicles
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. Multi-Section Reports (Theft, Fillings, Idling, Summary)
app.get('/api/reports/summary', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  const resourceId = parseInt(req.query.resourceId) || 29094703;
  const templateId = parseInt(req.query.templateId) || 5;
  const objectId = parseInt(req.query.objectId) || 29094722;

  const targetSection = req.query.section ? String(req.query.section).toLowerCase() : null;
  const specificTableIndex = req.query.tableIndex !== undefined ? parseInt(req.query.tableIndex) : null;

  // Dynamic calculation for today (00:00:00 IST to current second)
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0));

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
      interval: { from, to, flags: 16777216 }
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
      return res.json({ status: 'empty', message: 'No tables generated for this interval.', data: [] });
    }

    async function fetchTableData(index) {
      const rowParams = {
        tableIndex: index,
        config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
      };
      const rowsRes = await axios.get(WIALON_URL, {
        params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
      });

      const headers = reportTables[index]?.header || [];
      const rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

      const rows = rawRows.map((row, rIdx) => {
        const cols = (row.c || []).map((c) => (typeof c === 'object' ? c.t : c));
        const rowData = { index: rIdx + 1, entityName: row.t || cols[0] || 'Unknown' };
        headers.forEach((h, hIdx) => {
          if (cols[hIdx] !== undefined) rowData[h || `col_${hIdx}`] = cols[hIdx];
        });
        return rowData;
      });

      return {
        tableIndex: index,
        sectionName: reportTables[index]?.label || reportTables[index]?.name || `Table_${index}`,
        totalRows: rows.length,
        headers,
        rows
      };
    }

    let responsePayload;

    if (targetSection === 'all') {
      const allSections = [];
      for (let i = 0; i < reportTables.length; i++) {
        const tableData = await fetchTableData(i);
        allSections.push(tableData);
      }
      responsePayload = { sections: allSections };
    } else {
      let targetIdx = 0;
      if (specificTableIndex !== null && specificTableIndex < reportTables.length) {
        targetIdx = specificTableIndex;
      } else if (targetSection) {
        const found = reportTables.findIndex(
          (t) =>
            (t.label && t.label.toLowerCase().includes(targetSection)) ||
            (t.name && t.name.toLowerCase().includes(targetSection))
        );
        if (found !== -1) targetIdx = found;
      }

      const tableData = await fetchTableData(targetIdx);
      responsePayload = tableData;
    }

    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json({
      status: 'success',
      reportMeta: {
        resourceId,
        templateId,
        objectId,
        availableSections: reportTables.map((t, idx) => ({ index: idx, name: t.label || t.name }))
      },
      period: {
        fromTimestamp: from,
        toTimestamp: to,
        fromDate: new Date(from * 1000).toISOString(),
        toDate: new Date(to * 1000).toISOString()
      },
      ...responsePayload
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
