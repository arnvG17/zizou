import { validateFileSyntax } from './src/agent/verifier.js';

// Test with the syntax error file
const result = validateFileSyntax('test-syntax-error.html');
console.log('Test 1 - HTML with syntax error:', result);

// Test with a valid HTML file
const validHTML = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Valid</h1></body></html>';
import { writeFileSync, unlinkSync } from 'fs';
writeFileSync('test-valid.html', validHTML);
const validResult = validateFileSyntax('test-valid.html');
console.log('Test 2 - Valid HTML:', validResult);

// Test with invalid JSON
const invalidJSON = '{ "key": "value", }';
writeFileSync('test-invalid.json', invalidJSON);
const jsonResult = validateFileSyntax('test-invalid.json');
console.log('Test 3 - Invalid JSON:', jsonResult);

// Test with valid JSON
const validJSON = '{ "key": "value" }';
writeFileSync('test-valid.json', validJSON);
const validJsonResult = validateFileSyntax('test-valid.json');
console.log('Test 4 - Valid JSON:', validJsonResult);

// Cleanup
unlinkSync('test-valid.html');
unlinkSync('test-invalid.json');
unlinkSync('test-valid.json');
