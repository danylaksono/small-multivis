# Small Multivis - DuckDB Histogram

An interactive histogram visualization library powered by DuckDB-WASM and D3.js, designed for efficient client-side data analysis and visualization.

## Features

- 📊 Interactive histogram visualization with D3.js
- 🚀 Efficient data processing with DuckDB-WASM
- 🎯 Multiple selection modes (single, multiple, drag)
- 📈 Supports continuous, ordinal, and date data types
- 📁 Multiple data source formats (JSON, CSV, Parquet)
- 🎨 Customizable appearance and behavior
- 📱 Responsive design with automatic resizing

## Basic Usage

```javascript
import { Histogram } from 'duckdb-histogram';

// Create a histogram instance
const histogram = new Histogram({
  width: 600,
  height: 400,
  column: 'value',
  selectionMode: 'single'
});

// Load data and render
await histogram.initialize();
await histogram.loadData(data, 'json');
await histogram.update();

// Add to DOM
document.getElementById('visualization').appendChild(histogram.svg.node());
```

## Configuration Options

```javascript
const config = {
  width: 600,                    // Width of the chart
  height: 400,                   // Height of the chart
  margin: {                      // Chart margins
    top: 20,
    right: 20,
    bottom: 40,
    left: 40
  },
  column: 'value',               // Data column to visualize
  binThreshold: null,            // Custom bin threshold (optional)
  colors: ['steelblue', 'orange'], // Colors for bars [default, selected]
  maxOrdinalBins: 20,           // Maximum number of bins for ordinal data
  selectionMode: 'single',       // Selection mode: 'single', 'multiple', or 'drag'
  axis: false,                   // Show axes
  showLabelsBelow: false,        // Show labels below bars
  dataSource: null,              // Data source: URL, File object, or array
  dataFormat: null              // Data format: 'parquet', 'csv', or 'json'
};
```

## Events

```javascript
// Listen for selection changes
histogram.on('selectionChanged', (selectedData) => {
  console.log('Selected data:', selectedData);
});
```

## Data Loading Examples

```javascript
// Load from JSON array
await histogram.loadData([
  { value: 1 },
  { value: 2 },
  // ...
], 'json');

// Load from CSV file
const csvFile = new File(['...'], 'data.csv');
await histogram.loadData(csvFile, 'csv');

// Load from Parquet URL
await histogram.loadData('https://example.com/data.parquet', 'parquet');
```

## Methods

- `initialize()`: Set up the histogram
- `update()`: Update the visualization
- `clearSelection()`: Clear current selection
- `reset()`: Reset to initial state
- `destroy()`: Clean up resources
- `on(event, callback)`: Register event listeners

## Requirements

- D3.js v7+
- DuckDB-WASM v1.28+
- Modern browser with WebAssembly support

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
