'use strict';
// Builds the three monthly Excel files from report data and reads them back: values, Sunday highlighting, links.
const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx-js-style');
const { build } = require('../www/excel.js');

const days = 28, dows = Array.from({ length: days }, (_, i) => (0 + i) % 7);   // Feb 2026: day 1 is a Sunday
const rep = {
  company: 'Demo Co', month: '2026-02', month_name: 'February', year: 2026, days, dows, generated: '01/03/2026 10:00 am',
  employees: [{ id: 'E001', name: 'Ravi Kumar' }],
  pa: [{ id: 'E001', name: 'Ravi Kumar', codes: dows.map((d, i) => (i === 1 ? 'P' : i === 2 ? 'MC' : d === 0 ? 'WO' : 'L')), P: 1, L: 22, WO: 4, MC: 1, hours: 8.5 }],
  hours: [{ id: 'E001', name: 'Ravi Kumar', values: dows.map((d, i) => (i === 1 ? 8.5 : i === 2 ? 'MC' : '')), total: 8.5, days_worked: 1 }],
  location: [{ date: '2026-02-02', id: 'E001', name: 'Ravi Kumar', department: 'Service', site: 'Plant', in_time: '09:00', in_lat: 18.52, in_lng: 73.85, in_acc: 12, in_map: 'https://www.google.com/maps?q=18.52,73.85', photo_id: 'FILEX123456789', in_on: 'Yes', status: 'CLOSED', out_time: '17:30', out_lat: 18.6, out_lng: 73.9, out_acc: 20, out_map: 'https://www.google.com/maps?q=18.6,73.9', hours: 8.5 },
    { date: '2026-02-03', id: 'E001', name: 'Ravi Kumar', department: 'Service', site: 'Plant', in_time: '09:00', in_lat: 18.52, in_lng: 73.85, in_acc: 12, in_map: 'https://www.google.com/maps?q=18.52,73.85', photo_id: 'FILEY123456789', in_on: 'n/a', status: 'OPEN', out_time: null, hours: null }],
};
const roundtrip = (kind) => XLSX.read(XLSX.write(build(XLSX, rep, kind), { bookType: 'xlsx', type: 'buffer' }), { type: 'buffer', cellStyles: true });
const rgb = (c) => c && c.s && c.s.fgColor && c.s.fgColor.rgb;

test('P/L register: values, Sunday columns yellow, colours for P / MC / L', () => {
  const wb = roundtrip('pa'); assert.deepEqual(wb.SheetNames, ['PA_2026-02']); const ws = wb.Sheets['PA_2026-02'];
  assert.equal(ws.A1.v, 'Demo Co'); assert.match(ws.A2.v, /February 2026/);
  assert.equal(ws.D5.v, 1); assert.equal(rgb(ws.D5), 'FFFF00');                       // day 1 = Sunday header is yellow
  assert.equal(ws.D6.v, 'Sun'); assert.equal(rgb(ws.D6), 'FFFF00'); assert.equal(ws.E6.v, 'Mon');
  assert.equal(ws.D7.v, 'WO'); assert.equal(rgb(ws.D7), 'FFFF00');                      // Sunday cell yellow
  assert.equal(ws.E7.v, 'P'); assert.equal(rgb(ws.E7), 'C6EFCE'); assert.equal(ws.F7.v, 'MC'); assert.equal(rgb(ws.F7), 'FFD966'); assert.equal(ws.G7.v, 'L'); assert.equal(rgb(ws.G7), 'FFC7CE');
  const hdr = []; for (let c = 0; c < 40; c++) { const a = XLSX.utils.encode_cell({ r: 4, c }); if (ws[a]) hdr.push(ws[a].v); }
  assert.deepEqual(hdr.slice(-5), ['Present (P)', 'Leave (L)', 'Weekly Off (WO)', 'Missed Logout (MC)', 'Total Hours Worked']);
  assert.equal(ws[XLSX.utils.encode_cell({ r: 6, c: 3 + days })].v, 1); assert.equal(ws[XLSX.utils.encode_cell({ r: 6, c: 3 + days + 4 })].v, 8.5);
});
test('Hours report: hours per day, MC shown (not counted), totals', () => {
  const ws = roundtrip('hours').Sheets['Hours_2026-02']; assert.equal(ws.E7.v, 8.5); assert.equal(ws.F7.v, 'MC'); assert.equal(rgb(ws.D7), 'FFFF00');
  assert.equal(ws[XLSX.utils.encode_cell({ r: 6, c: 3 + days })].v, 8.5); assert.equal(ws[XLSX.utils.encode_cell({ r: 6, c: 3 + days + 1 })].v, 1);
});
test('Location report: map + photo links are clickable; open session shows NOT LOGGED OUT', () => {
  const ws = roundtrip('location').Sheets['Location_2026-02'];
  assert.equal(ws.A5.v, 'Date'); assert.equal(ws.J6.v, 'Open map'); assert.equal(ws.J6.l.Target, 'https://www.google.com/maps?q=18.52,73.85');
  assert.equal(ws.K6.v, 'View photo'); assert.equal(ws.K6.l.Target, 'https://drive.google.com/file/d/FILEX123456789/view'); assert.equal(ws.L6.v, '17:30'); assert.equal(ws.Q6.v, 8.5);
  assert.equal(ws.L7.v, 'NOT LOGGED OUT'); assert.equal(ws.R7.v, 'OPEN');
});
test('Complete workbook has all three tabs', () => { assert.equal(roundtrip('all').SheetNames.length, 3); });
