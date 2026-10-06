"use strict";
const fs = require("node:fs");
// Summarize serial, unprofiled harness logs without rounding away raw samples.
const samples = process.argv.slice(2).flatMap(file => [...fs.readFileSync(file, "utf8").matchAll(/MEASURE (\{[^\n]+\})/g)].map(match => JSON.parse(match[1])));
const counts = [...new Set(samples.map(row => row.count))];
for (const count of counts) {
  const rows = samples.filter(row => row.count === count);
  const median = values => {
    values.sort((a,b) => a-b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle-1] + values[middle]) / 2;
  };
  console.log(JSON.stringify({ count, samples: rows.length, ...Object.fromEntries(Object.keys(rows[0]).filter(key => key.endsWith('MS')).map(key => [key, median(rows.map(row => row[key]))])) }));
}
