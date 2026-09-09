// Universal Multi-Table Report Endpoint
app.get('/api/reports/summary', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  const resourceId = parseInt(req.query.resourceId) || 29094703;
  const templateId = parseInt(req.query.templateId) || 5;
  const objectId = parseInt(req.query.objectId) || 29094722;

  // Selected table query: can be index (0, 1, 2...) or name ("fuel_theft", "fillings", "all")
  const targetSection = req.query.section ? String(req.query.section).toLowerCase() : null;
  const specificTableIndex = req.query.tableIndex !== undefined ? parseInt(req.query.tableIndex) : null;

  // Dynamic "Today" Calculation in IST (UTC+5:30)
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

    // 1. Run the report
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

    // Helper to fetch rows for a given table index
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
        // Create a mapped key-value object using Wialon's actual column names
        const rowData = { index: rIdx + 1, entityName: row.t || cols[0] };
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

    // Case A: Fetch all sections
    if (targetSection === 'all') {
      const allSections = [];
      for (let i = 0; i < reportTables.length; i++) {
        const tableData = await fetchTableData(i);
        allSections.push(tableData);
      }
      responsePayload = { sections: allSections };

    // Case B: Fetch specific index or matched keyword
    } else {
      let targetIdx = 0; // Default to Consolidated Summary

      if (specificTableIndex !== null && specificTableIndex < reportTables.length) {
        targetIdx = specificTableIndex;
      } else if (targetSection) {
        const found = reportTables.findIndex(t => 
          (t.label && t.label.toLowerCase().includes(targetSection)) ||
          (t.name && t.name.toLowerCase().includes(targetSection))
        );
        if (found !== -1) targetIdx = found;
      }

      const tableData = await fetchTableData(targetIdx);
      responsePayload = tableData;
    }

    // 3. Clear report memory from Wialon server
    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json({
      status: 'success',
      reportMeta: {
        resourceId,
        templateId,
        objectId,
        availableSections: reportTables.map((t, idx) => ({ index: idx, name: t.label || t.name }))
      },
      ...responsePayload
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});
