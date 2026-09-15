#!/usr/bin/env node
const puppeteer = require('puppeteer-core');
const path = require('path');

const inputHtml = process.argv[2];
const outputPng = process.argv[3];
const width = parseInt(process.argv[4] || '1600', 10);
const height = parseInt(process.argv[5] || '820', 10);

if (!inputHtml || !outputPng) {
  console.error('Usage: node screenshot.js <input.html> <output.png> [width] [height]');
  process.exit(1);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.goto('file://' + path.resolve(inputHtml), {
    waitUntil: 'networkidle0'
  });
  await page.screenshot({
    path: outputPng,
    fullPage: false
  });
  await browser.close();
  console.log('Screenshot saved to:', outputPng);
})();
