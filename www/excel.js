'use strict';
/* Builds the monthly Excel workbooks from the data returned by the backend (report_month).
   Layout follows the proven VATS v2.5 reports: P/L/WO/MC register, hours per day, location register with map + photo links.
   Sundays are highlighted yellow. Works in the phone app and in Node tests (XLSX = xlsx-js-style). */
(function (root) {
  const NAVY = '1F3864', YELLOW = 'FFFF00', GREEN = 'C6EFCE', RED = 'FFC7CE', ORANGE = 'FFD966', WHITE = 'FFFFFF';
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const thin = { style: 'thin', color: { rgb: '999999' } }, border = { top: thin, bottom: thin, left: thin, right: thin };
  const cell = (v, fill, o = {}) => ({ v, t: typeof v === 'number' ? 'n' : 's', s: Object.assign({ alignment: { horizontal: o.left ? 'left' : 'center', vertical: 'center' }, border, fill: fill ? { patternType: 'solid', fgColor: { rgb: fill } } : undefined, font: { bold: !!o.bold, color: { rgb: o.color || '000000' }, sz: o.sz || 11 } }, {}) });
  const plain = (v, o = {}) => ({ v, t: typeof v === 'number' ? 'n' : 's', s: { font: { bold: !!o.bold, sz: o.sz || 11 } } });
  const link = (text, url, fill) => { const c = cell(text, fill, { color: '0563C1' }); c.l = { Target: url }; c.s.font.underline = true; return c; };
  const head = (rep, title) => [[plain(rep.company, { bold: true, sz: 14 })], [plain(title + ' - ' + rep.month_name + ' ' + rep.year, { bold: true })],
    [plain('Generated: ' + (rep.generated || '') + ' IST')], []];
  const sheet = (XLSX, rows, widths, freezeRow, freezeCol) => {
    const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = widths.map(w => ({ wch: w }));
    if (freezeRow) ws['!freeze'] = { xSplit: freezeCol || 0, ySplit: freezeRow }; ws['!views'] = [{ state: 'frozen', xSplit: freezeCol || 0, ySplit: freezeRow || 0 }];
    return ws;
  };
  const legend = (items) => [[], [plain('Legend:', { bold: true })]].concat(items.map(([t, f]) => [cell(t, f, { left: true })]));
  const dayHeaders = (rep) => { const h = []; for (let d = 1; d <= rep.days; d++) h.push(cell(d, rep.dows[d - 1] === 0 ? YELLOW : NAVY, { bold: true, color: rep.dows[d - 1] === 0 ? '000000' : WHITE })); return h; };
  const weekRow = (rep, extra) => { const r = [cell('', null), cell('', null), cell('', null)]; for (let d = 1; d <= rep.days; d++) r.push(cell(WD[rep.dows[d - 1]], rep.dows[d - 1] === 0 ? YELLOW : null)); for (let i = 0; i < extra; i++) r.push(cell('', null)); return r; };
  const dayW = (rep, w) => Array(rep.days).fill(w);

  function paSheet(XLSX, rep) {
    const tot = ['Present (P)', 'Leave (L)', 'Weekly Off (WO)', 'Missed Logout (MC)', 'Total Hours Worked'];
    const rows = head(rep, 'Monthly Attendance Register (P / L) with Hours');
    rows.push([cell('Sr No.', NAVY, { bold: true, color: WHITE }), cell('Employee ID', NAVY, { bold: true, color: WHITE }), cell('Employee Name', NAVY, { bold: true, color: WHITE })].concat(dayHeaders(rep), tot.map(t => cell(t, NAVY, { bold: true, color: WHITE }))));
    rows.push(weekRow(rep, tot.length));
    rep.pa.forEach((e, i) => {
      const r = [cell(i + 1, null), cell(e.id, null), cell(e.name, null, { left: true })];
      e.codes.forEach((c, k) => { const sun = rep.dows[k] === 0; r.push(cell(c, sun ? YELLOW : c === 'P' ? GREEN : c === 'L' ? RED : c === 'MC' ? ORANGE : null, { bold: !!c })); });
      r.push(cell(e.P, null), cell(e.L, null), cell(e.WO, null), cell(e.MC, null), cell(e.hours, null, { bold: true })); rows.push(r);
    });
    legend([['P = login and logout both marked', GREEN], ['L = Leave (no attendance marked that day)', RED], ['WO = Sunday weekly off (yellow column)', YELLOW], ['MC = logged in, logout missing (hours not counted)', ORANGE]]).forEach(r => rows.push(r));
    rows.push([plain('Dates after today are left blank. Public holidays are not configured. A night shift is counted on the day of login.')]);
    return sheet(XLSX, rows, [8, 14, 30].concat(dayW(rep, 5), [13, 11, 15, 17, 18]), 6, 3);
  }
  function hoursSheet(XLSX, rep) {
    const tot = ['Total Hours Worked', 'Days Worked'];
    const rows = head(rep, 'Hours Worked per Day');
    rows.push([cell('Sr No.', NAVY, { bold: true, color: WHITE }), cell('Employee ID', NAVY, { bold: true, color: WHITE }), cell('Employee Name', NAVY, { bold: true, color: WHITE })].concat(dayHeaders(rep), tot.map(t => cell(t, NAVY, { bold: true, color: WHITE }))));
    rows.push(weekRow(rep, tot.length));
    rep.hours.forEach((e, i) => {
      const r = [cell(i + 1, null), cell(e.id, null), cell(e.name, null, { left: true })];
      e.values.forEach((v, k) => { const sun = rep.dows[k] === 0; r.push(cell(v, sun ? YELLOW : v === 'MC' ? ORANGE : v !== '' ? GREEN : null)); });
      r.push(cell(e.total, null, { bold: true }), cell(e.days_worked, null)); rows.push(r);
    });
    legend([['Number = hours worked that day (login to logout)', GREEN], ['MC = logged in, logout missing (hours not counted)', ORANGE], ['Yellow column = Sunday', YELLOW]]).forEach(r => rows.push(r));
    return sheet(XLSX, rows, [8, 14, 30].concat(dayW(rep, 7), [18, 13]), 6, 3);
  }
  function locationSheet(XLSX, rep) {
    const H = ['Date', 'Employee ID', 'Name', 'Department', 'Site', 'IN Time', 'IN Latitude', 'IN Longitude', 'IN Accuracy (m)', 'IN Location', 'Photo (geo-tag proof)', 'OUT Time', 'OUT Latitude', 'OUT Longitude', 'OUT Accuracy (m)', 'OUT Location', 'Hours Worked', 'Status', 'On site? (if site set)'];
    const rows = head(rep, 'Location Register (login photo + GPS, logout GPS)');
    rows.push(H.map(t => cell(t, NAVY, { bold: true, color: WHITE })));
    rep.location.forEach(r => {
      const out = r.status === 'CLOSED', fill = out ? null : ORANGE;
      rows.push([cell(r.date, null), cell(r.id, null), cell(r.name, null, { left: true }), cell(r.department || '', null), cell(r.site || '', null), cell(r.in_time || '', null), cell(r.in_lat ?? '', null), cell(r.in_lng ?? '', null), cell(r.in_acc ?? '', null),
        r.in_map ? link('Open map', r.in_map) : cell('', null), r.photo_id ? link('View photo', 'https://drive.google.com/file/d/' + r.photo_id + '/view') : cell('', null),
        cell(out ? r.out_time : 'NOT LOGGED OUT', fill), cell(out ? (r.out_lat ?? '') : '', null), cell(out ? (r.out_lng ?? '') : '', null), cell(out ? (r.out_acc ?? '') : '', null),
        out && r.out_map ? link('Open map', r.out_map) : cell('', null), cell(out ? (r.hours ?? '') : '', null), cell(r.status, fill), cell(r.in_on || '', null)]);
    });
    return sheet(XLSX, rows, [11, 11, 28, 14, 16, 8, 11, 11, 10, 12, 16, 15, 11, 11, 10, 12, 10, 9, 12], 5, 0);
  }
  // kinds: 'pa' | 'hours' | 'location' | 'all'
  function build(XLSX, rep, kind) {
    const wb = XLSX.utils.book_new(), ym = rep.month;
    if (kind === 'pa' || kind === 'all') XLSX.utils.book_append_sheet(wb, paSheet(XLSX, rep), 'PA_' + ym);
    if (kind === 'hours' || kind === 'all') XLSX.utils.book_append_sheet(wb, hoursSheet(XLSX, rep), 'Hours_' + ym);
    if (kind === 'location' || kind === 'all') XLSX.utils.book_append_sheet(wb, locationSheet(XLSX, rep), 'Location_' + ym);
    return wb;
  }
  root.FA_Excel = { build };
  if (typeof module !== 'undefined' && module.exports) module.exports = { build };
})(typeof window !== 'undefined' ? window : globalThis);
