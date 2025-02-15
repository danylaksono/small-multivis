import * as d3 from "d3";
import _ from "lodash";
import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm";
import mvp_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js";
import duckdb_wasm_eh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm";
import eh_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js";

const MANUAL_BUNDLES = {
  mvp: {
    mainModule: duckdb_wasm,
    mainWorker: mvp_worker,
  },
  eh: {
    mainModule: duckdb_wasm_eh,
    mainWorker: eh_worker,
  },
};

export class Histogram {
  constructor(config) {
    console.log("DuckDB Histogram initialized with config:", config);
    const defaults = {
      width: 600,
      height: 400,
      margin: { top: 20, right: 20, bottom: 40, left: 40 },
      column: null,
      binThreshold: null,
      colors: ["steelblue", "orange"],
      maxOrdinalBins: 20,
      selectionMode: "single", // 'single', 'multiple', 'drag'
      axis: false,
      showLabelsBelow: false,
      dataSource: null, // Can be: URL, File object, or array of objects
      dataFormat: null, // 'parquet', 'csv', or 'json'
    };

    this.config = { ...defaults, ...config };
    this.data = [];
    this.selectedBins = new Set();
    this.dispatch = d3.dispatch("selectionChanged");
    this.initialized = false;

    // ducks
    this.duckdb = null; // DuckDB connection
    this.tableName = null; // Name of the table/view in DuckDB
    this.queryCache = null; // Cache for query results
    this.conn = null;
    this.tableName = `data_${Math.random().toString(36).substr(2, 9)}`; // Generate unique table name

    // Automatically initialize the histogram
    this.createSvg();
  }

  async initDuckDB(duckdbConnection, tableName) {
    this.duckdb = duckdbConnection;
    this.tableName = tableName;
  }

  async processDataWithDuckDB() {
    const { column } = this.config;
    this.type = await this.getTypeFromDuckDB(column);
    this.bins = await this.binDataWithDuckDB(column, this.type);

    this.xScale = this.createXScale();
    this.yScale = this.createYScale();
  }

  async getTypeFromDuckDB(column) {
    const query = `
      SELECT typeof(${column}) as col_type 
      FROM ${this.tableName} 
      WHERE ${column} IS NOT NULL 
      LIMIT 1
    `;

    const result = await this.conn.query(query);
    const type = result.toArray()[0].col_type.toLowerCase();

    if (type.includes("float") || type.includes("integer")) return "continuous";
    if (type.includes("date") || type.includes("timestamp")) return "date";
    return "ordinal";
  }

  // https://duckdb.org/docs/sql/data_types/overview
  getDuckDBType(type) {
    switch (type?.toUpperCase()) {
      case "BIGINT":
      case "HUGEINT":
      case "UBIGINT":
        return "bigint";
      case "DOUBLE":
      case "REAL":
      case "FLOAT":
        return "number";
      case "INTEGER":
      case "SMALLINT":
      case "TINYINT":
      case "USMALLINT":
      case "UINTEGER":
      case "UTINYINT":
        return "integer";
      case "BOOLEAN":
        return "boolean";
      case "DATE":
      case "TIMESTAMP":
      case "TIMESTAMP WITH TIME ZONE":
        return "date";
      case "VARCHAR":
      case "UUID":
        return "string";
      // case "BLOB":
      // case "INTERVAL":
      // case "TIME":
      default:
        if (/^DECIMAL\(/.test(type)) return "integer";
        return "other";
    }
  }

  async binDataWithDuckDB(column, type) {
    let query;

    switch (type) {
      case "continuous":
        // First get the column type to handle casting properly
        const typeQuery = `SELECT typeof(${column}) as col_type 
                          FROM ${this.tableName} 
                          WHERE ${column} IS NOT NULL 
                          LIMIT 1`;
        const typeResult = await this.logQuery(typeQuery, "Get Column Type");
        const colType = typeResult.toArray()[0].col_type;
        const numericType = this.getDuckDBType(colType);

        query = `
          WITH stats AS (
            SELECT 
              MIN(${column}) as min_val,
              MAX(${column}) as max_val,
              COUNT(*) as n,
              (MAX(${column}) - MIN(${column})) as range
            FROM ${this.tableName}
            WHERE ${column} IS NOT NULL
          ),
          bin_params AS (
            SELECT 
              min_val,
              max_val,
              (max_val - min_val) / 10.0 as bin_width
            FROM stats
          ),
          bins AS (
            SELECT 
              min_val + (CAST(value - 1 AS ${colType}) * bin_width) as x0,
              min_val + (CAST(value AS ${colType}) * bin_width) as x1
            FROM generate_series(1, 10) vals(value), bin_params
          )
          SELECT
            x0,
            x1,
            COUNT(${column}) as length
          FROM ${this.tableName}
          CROSS JOIN bins
          WHERE ${column} >= x0 AND ${column} < x1
          GROUP BY x0, x1
          ORDER BY x0
        `;
        break;

      case "date":
        query = `
          SELECT 
            date_trunc('day', ${column}) as x0,
            date_trunc('day', ${column}) + INTERVAL '1 day' as x1,
            COUNT(*) as length
          FROM ${this.tableName}
          WHERE ${column} IS NOT NULL
          GROUP BY date_trunc('day', ${column})
          ORDER BY x0
        `;
        break;

      case "ordinal":
        query = `
          SELECT 
            ${column} as key,
            ${column} as x0,
            ${column} as x1,
            COUNT(*) as length
          FROM ${this.tableName}
          WHERE ${column} IS NOT NULL
          GROUP BY ${column}
          ORDER BY length DESC
          LIMIT ${this.config.maxOrdinalBins}
        `;
        break;
    }

    const result = await this.conn.query(query);
    let bins = result.toArray().map((row) => ({
      ...row,
      x0: type === "date" ? new Date(row.x0) : row.x0,
      x1: type === "date" ? new Date(row.x1) : row.x1,
    }));

    if (type === "ordinal" && bins.length === this.config.maxOrdinalBins) {
      const othersQuery = `
        WITH ranked AS (
          SELECT ${column}, COUNT(*) as cnt
          FROM ${this.tableName}
          WHERE ${column} IS NOT NULL
          GROUP BY ${column}
          ORDER BY cnt DESC
          OFFSET ${this.config.maxOrdinalBins - 1}
        )
        SELECT SUM(cnt) as length
        FROM ranked
      `;

      const othersResult = await this.conn.query(othersQuery);
      const othersCount = othersResult.toArray()[0].length;

      if (othersCount > 0) {
        bins.push({
          key: "Other",
          x0: "Other",
          x1: "Other",
          length: othersCount,
        });
      }
    }

    return bins;
  }

  async initialize() {
    if (!this.initialized) {
      this.createSvg();
    }

    // Initialize DuckDB if not already done
    if (!this.duckdb) {
      await this.setupDuckDB();
    }

    // Load data if provided
    if (this.config.dataSource) {
      await this.loadData(this.config.dataSource, this.config.dataFormat);
    }

    return this;
  }

  async setupDuckDB() {
    try {
      const duckdb = await import("@duckdb/duckdb-wasm");
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);

      // Construct worker URL relative to the current module
      const workerURL = new URL(
        "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js",
        import.meta.url
      );

      const worker = new Worker(workerURL.toString());

      this.duckdb = new duckdb.AsyncDuckDB(logger, worker);
      await this.duckdb.instantiate(duckdb_wasm);

      this.conn = await this.duckdb.connect();
    } catch (error) {
      throw new Error(`Failed to initialize DuckDB: ${error.message}`);
    }
  }

  async loadData(source, format) {
    try {
      // Drop existing table if it exists
      await this.conn.query(`DROP TABLE IF EXISTS ${this.tableName}`);

      if (Array.isArray(source)) {
        // Handle JavaScript array of objects
        await this.loadJSONData(source);
      } else if (source instanceof File) {
        // Handle File object
        await this.loadFileData(source, format);
      } else if (typeof source === "string") {
        // Handle URL
        await this.loadURLData(source, format);
      } else {
        throw new Error("Unsupported data source");
      }

      // Verify data loading
      const countResult = await this.conn.query(
        `SELECT COUNT(*) as count FROM ${this.tableName}`
      );
      const count = countResult.toArray()[0].count;

      if (count === 0) {
        throw new Error("No data was loaded");
      }
    } catch (error) {
      throw new Error(`Failed to load data: ${error.message}`);
    }
  }

  async loadJSONData(data) {
    try {
      if (data.length === 0) {
        throw new Error("Empty data array provided");
      }

      // Infer schema from the first object
      const schema = this.inferSchema(data[0]);
      const createTableSQL = this.generateCreateTableSQL(schema);

      // Create the table
      await this.conn.query(createTableSQL);
      console.log("Table created successfully");

      // Insert data in batches using SQL INSERT
      const batchSize = 1000;
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);

        // Generate INSERT query for the batch
        const columns = Object.keys(schema)
          .map((col) => `"${col}"`)
          .join(", ");
        const values = batch
          .map((row) => {
            const rowValues = Object.values(row).map((val) => {
              if (val === null || val === undefined) return "NULL";
              if (typeof val === "string")
                return `'${val.replace(/'/g, "''")}'`; // Escape single quotes
              if (val instanceof Date) return `'${val.toISOString()}'`; // Format dates
              return val;
            });
            return `(${rowValues.join(", ")})`;
          })
          .join(", ");

        const insertQuery = `INSERT INTO ${this.tableName} (${columns}) VALUES ${values}`;
        await this.conn.query(insertQuery);
        console.log(`Inserted batch ${i / batchSize + 1}`);
      }

      console.log("JSON data loaded successfully");
    } catch (error) {
      console.error("Failed to load JSON data:", error);
      throw new Error(`Failed to load JSON data: ${error.message}`);
    }
  }

  async loadFileData(file, format) {
    try {
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);

      if (format === "parquet") {
        await this.duckdb.registerFileBuffer(file.name, uint8Array);
        await this.conn.query(`
          CREATE TABLE ${this.tableName} AS 
          SELECT * FROM parquet_scan('${file.name}')
        `);
      } else if (format === "csv") {
        await this.duckdb.registerFileBuffer(file.name, uint8Array);
        await this.conn.query(`
          CREATE TABLE ${this.tableName} AS 
          SELECT * FROM read_csv_auto('${file.name}')
        `);
      } else {
        throw new Error("Unsupported file format");
      }
    } catch (error) {
      throw new Error(`Failed to load file: ${error.message}`);
    }
  }

  async loadURLData(url, format) {
    try {
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      const filename = url.split("/").pop();

      await this.loadFileData(
        new File([uint8Array], filename, { type: `application/${format}` }),
        format
      );
    } catch (error) {
      throw new Error(`Failed to load URL data: ${error.message}`);
    }
  }

  inferSchema(obj) {
    const schema = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value instanceof Date) {
        schema[key] = "TIMESTAMP";
      } else if (typeof value === "number") {
        schema[key] = Number.isInteger(value) ? "INTEGER" : "DOUBLE";
      } else if (typeof value === "boolean") {
        schema[key] = "BOOLEAN";
      } else {
        schema[key] = "VARCHAR";
      }
    }
    return schema;
  }

  escape(name) {
    return `"${name}"`;
  }

  async describeColumn(column) {
    const query = `DESCRIBE ${this.escape(this.tableName)}`;
    const result = await this.conn.query(query);
    const columnInfo = result
      .toArray()
      .find((row) => row.column_name === column);
    return {
      name: columnInfo.column_name,
      type: this.getDuckDBType(columnInfo.column_type),
      nullable: columnInfo.null !== "NO",
      databaseType: columnInfo.column_type,
    };
  }

  generateCreateTableSQL(schema) {
    const columns = Object.entries(schema)
      .map(([name, type]) => `"${name}" ${type}`)
      .join(", ");
    return `CREATE TABLE ${this.tableName} (${columns})`;
  }

  // Clean up resources
  async destroy() {
    if (this.conn) {
      await this.conn.query(`DROP TABLE IF EXISTS ${this.tableName}`);
      await this.conn.close();
    }
    if (this.duckdb) {
      await this.duckdb.terminate();
    }
    this.svg.remove();
    this.tooltip.remove();
    this.initialized = false;
  }

  createSvg() {
    const { width, height, margin } = this.config;

    // Create the SVG container using d3.create
    this.svg = d3
      .create("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom)
      .attr("viewBox", [
        0,
        0,
        width + margin.left + margin.right,
        height + margin.top + margin.bottom,
      ])
      .attr("style", "max-width: 100%; height: auto;");

    // Create a group element for the histogram
    this.g = this.svg
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Tooltip for hover
    this.tooltip = d3
      .select("body")
      .append("div")
      .attr("class", "histogram-tooltip")
      .style("opacity", 0)
      .style("position", "absolute")
      .style("background", "white")
      .style("padding", "5px")
      .style("border", "1px solid #ccc");

    // Labels below the histogram
    if (this.config.showLabelsBelow) {
      this.labelGroup = this.g
        .append("g")
        .attr("class", "labels")
        // Remove the centerX translation and just use height
        .attr("transform", `translate(0,${this.config.height + 25})`);
    }

    // Brush for drag selection
    this.brush = d3
      .brushX()
      .extent([
        [0, 0],
        [this.config.width, this.config.height],
      ])
      .on("end", this.handleBrush.bind(this));

    // Click outside bins to clear selection
    this.g.on("click", (event) => {
      if (!event.target.classList.contains("bar")) {
        this.clearSelection();
      }
    });

    this.initialized = true;
    return this.svg.node(); // Return the SVG node
  }

  async update(data = null) {
    if (!this.initialized) {
      this.createSvg();
    }

    if (data) {
      // Direct data update (old behavior)
      this.data = data;
      this.processData();
    } else if (this.duckdb && this.tableName) {
      // Process data using DuckDB
      await this.processDataWithDuckDB();
    }

    this.draw();
    return this;
  }

  processData() {
    const { column } = this.config;
    this.type = this.getType(this.data, column);
    this.bins = this.binData(this.data, column, this.type);

    this.xScale = this.createXScale();
    this.yScale = this.createYScale();
  }

  getType(data, column) {
    for (const d of data) {
      const value = d[column];
      if (value === undefined) continue;
      if (value == null) continue;
      if (typeof value === "number") return "continuous";
      if (value instanceof Date) return "date";
      return "ordinal";
    }
    return "ordinal";
  }

  binData(data, column, type) {
    const accessor = (d) => d[column];
    let bins;

    switch (type) {
      case "continuous":
        const threshold =
          this.config.binThreshold || d3.thresholdFreedmanDiaconis;
        const histogram = d3.histogram().value(accessor).thresholds(threshold);
        bins = histogram(data);
        break;

      case "date":
        const timeHistogram = d3
          .histogram()
          .value((d) => accessor(d).getTime())
          .thresholds(d3.timeMillisecond.every(86400000)); // Daily bins by default
        bins = timeHistogram(data);
        break;

      case "ordinal":
        const grouped = _.groupBy(data, accessor);
        bins = Object.entries(grouped).map(([key, values]) => ({
          key,
          length: values.length,
          x0: key,
          x1: key,
        }));
        if (bins.length > this.config.maxOrdinalBins) {
          bins = this.handleLargeOrdinalBins(bins);
        }
        break;
    }

    return bins;
  }

  createXScale() {
    const {
      type,
      bins,
      config: { width },
    } = this;

    if (type === "ordinal") {
      return d3
        .scaleBand()
        .domain(bins.map((b) => b.key))
        .range([0, width])
        .padding(0.1);
    }

    const extent = d3.extent(bins.flatMap((b) => [b.x0, b.x1]));
    return type === "date"
      ? d3.scaleTime().domain(extent).range([0, width])
      : d3.scaleLinear().domain(extent).range([0, width]);
  }

  createYScale() {
    const max = d3.max(this.bins, (b) => Number(b.length)); // Convert BigInt to Number
    return d3
      .scaleLinear()
      .domain([0, max])
      .nice()
      .range([this.config.height, 0]);
  }

  draw() {
    this.drawBars(); // Draw bars first
    if (this.config.axis) this.drawAxes(); // Draw axes if enabled
    if (this.config.showLabelsBelow) this.drawLabels(); // Draw labels if enabled

    // Draw brush overlay on top of bars
    if (this.config.selectionMode === "drag") {
      this.g
        .append("g") // Append brush group after bars
        .attr("class", "brush")
        .call(this.brush);
    }
  }

  drawBars() {
    const {
      xScale,
      yScale,
      config: { height },
      bins,
    } = this;
    const bars = this.g.selectAll(".bar").data(bins, (b) => b.x0);

    bars.exit().remove();

    const enter = bars
      .enter()
      .append("rect")
      .attr("class", "bar")
      .attr("stroke", "white")
      .attr("stroke-width", "1")
      .on("mouseover", (event, d) => this.handleMouseOver(event, d))
      .on("mouseout", (event, d) => this.handleMouseOut(event, d))
      .on("click", (event, d) => this.handleClick(event, d));

    bars
      .merge(enter)
      .attr("x", (b) => xScale(b.x0))
      .attr("y", (b) => yScale(Number(b.length))) // Convert BigInt to Number
      .attr("width", (b) => this.getBarWidth(b))
      .attr("height", (b) => height - yScale(Number(b.length))) // Convert BigInt to Number
      .attr("fill", (b) =>
        this.selectedBins.has(b) ? this.config.colors[1] : this.config.colors[0]
      );
  }

  drawLabels() {
    const { xScale, bins, type } = this;

    // Clear existing labels
    this.labelGroup.selectAll(".label").remove();

    // Calculate total width for centering
    const totalWidth = this.config.width;

    // Update labelGroup position to align with the bars
    this.labelGroup.attr(
      "transform",
      `translate(0,${this.config.height + 25})`
    );

    // Add new labels
    this.labelGroup
      .selectAll(".label")
      .data(bins)
      .enter()
      .append("text")
      .attr("class", "label")
      .attr("text-anchor", "middle")
      .attr("fill", "#333")
      .attr("font-size", "12px")
      .attr("x", (b) => {
        if (type === "ordinal") {
          return xScale(b.x0) + xScale.bandwidth() / 2;
        }
        // For continuous/date data, center between x0 and x1
        const x0 = xScale(b.x0);
        const x1 = xScale(b.x1);
        return x0 + (x1 - x0) / 2;
      })
      .text((b) => {
        if (type === "ordinal") {
          return `${b.key}: ${b.length}`;
        }
        if (type === "date") {
          const formatter = d3.timeFormat("%Y-%m-%d");
          return `${formatter(b.x0)}: ${b.length}`;
        }
        // For continuous numeric data, format numbers nicely
        return `${b.x0.toFixed(1)}-${b.x1.toFixed(1)}: ${b.length}`;
      });
  }

  getBarWidth(b) {
    if (this.type === "ordinal") {
      // Use scaleBand bandwidth for ordinal data
      return this.xScale.bandwidth();
    }

    // For continuous/date data, calculate width from scales
    const width = Math.max(1, this.xScale(b.x1) - this.xScale(b.x0));
    return isNaN(width) ? 0 : width;
  }

  handleMouseOver(event, d) {
    if (this.config.showLabelsBelow) {
      // Hide tooltip when showing labels
      this.tooltip.style("opacity", 0);

      // Clear previous labels
      this.labelGroup.selectAll(".label").remove();

      // Add new label
      this.labelGroup
        .append("text")
        .attr("class", "label")
        .attr("text-anchor", "middle")
        .attr("fill", "#333")
        .attr("font-size", "12px")
        .text(`${d.key || d.x0}: ${d.length}`);
    } else {
      // Show tooltip if labels are disabled
      this.tooltip
        .style("opacity", 1)
        .html(`Category: ${d.key || d.x0}<br>Count: ${d.length}`)
        .style("left", `${event.pageX}px`)
        .style("top", `${event.pageY + 10}px`);
    }

    d3.select(event.currentTarget).attr("fill", this.config.colors[1]);
  }

  handleMouseOut(event) {
    // Clear both tooltip and labels
    this.tooltip.style("opacity", 0);
    if (this.config.showLabelsBelow) {
      this.labelGroup.selectAll(".label").remove();
    }

    const bin = this.bins.find((b) => b.x0 === event.currentTarget.__data__.x0);
    d3.select(event.currentTarget).attr(
      "fill",
      this.selectedBins.has(bin) ? this.config.colors[1] : this.config.colors[0]
    );
  }

  handleClick(event, d) {
    const isSelected = this.selectedBins.has(d);

    if (event.ctrlKey && this.config.selectionMode === "multiple") {
      this.selectedBins.has(d)
        ? this.selectedBins.delete(d)
        : this.selectedBins.add(d);
    } else {
      if (isSelected) {
        this.selectedBins.clear();
      } else {
        this.selectedBins.clear();
        this.selectedBins.add(d);
      }
    }

    // Get selected data and dispatch when ready
    this.getSelectedData().then((selectedData) => {
      this.dispatch.call("selectionChanged", this, selectedData);
    });

    this.drawBars();
  }

  handleBrush(event) {
    if (!event.selection) {
      this.clearSelection();
      return;
    }

    const [x0, x1] = event.selection;
    const selected = this.bins.filter((b) => {
      const binLeft = this.xScale(b.x0);
      const binRight = this.xScale(b.x1);
      return binLeft <= x1 && binRight >= x0;
    });

    this.selectedBins = new Set(selected);
    this.drawBars();

    // Get selected data and dispatch when ready
    this.getSelectedData().then((selectedData) => {
      this.dispatch.call("selectionChanged", this, selectedData);
    });
  }

  async getSelectedData() {
    if (this.selectedBins.size === 0) return [];

    const selectedBins = Array.from(this.selectedBins);
    let query;

    if (this.type === "ordinal") {
      const values = selectedBins.map((bin) => `'${bin.key}'`).join(",");
      query = `
        SELECT *
        FROM ${this.tableName}
        WHERE ${this.config.column} IN (${values})
      `;
    } else {
      const conditions = selectedBins
        .map(
          (bin) =>
            `(${this.config.column} >= ${bin.x0} AND ${this.config.column} < ${bin.x1})`
        )
        .join(" OR ");

      query = `
        SELECT *
        FROM ${this.tableName}
        WHERE ${conditions}
      `;
    }

    // Changed from this.duckdb.query to this.conn.query
    const result = await this.conn.query(query);
    return result.toArray();
  }

  clearSelection() {
    this.selectedBins.clear();
    this.drawBars();
    // Return empty array immediately since there's no selection
    this.dispatch.call("selectionChanged", this, []);
  }

  reset() {
    this.selectedBins.clear();
    this.processData();
    this.draw();
  }

  on(event, callback) {
    this.dispatch.on(event, callback);
    return this;
  }

  // destroy() {
  //   this.svg.remove();
  //   this.tooltip.remove();
  //   this.initialized = false;
  // }

  // Utility methods
  handleLargeOrdinalBins(bins) {
    const sorted = _.orderBy(bins, ["length"], ["desc"]);
    const topBins = sorted.slice(0, this.config.maxOrdinalBins - 1);
    const others = sorted.slice(this.config.maxOrdinalBins - 1);
    const otherBin = {
      key: "Other",
      length: _.sumBy(others, "length"),
      x0: "Other",
      x1: "Other",
    };
    return [...topBins, otherBin];
  }

  drawAxes() {
    // Remove existing axes
    this.g.selectAll(".axis").remove();

    // Create X axis
    const xAxis = d3.axisBottom(this.xScale).tickFormat((d) => {
      if (this.type === "date") {
        return d3.timeFormat("%Y-%m-%d")(d);
      }
      return d;
    });

    this.g
      .append("g")
      .attr("class", "axis x-axis")
      .attr("transform", `translate(0,${this.config.height})`)
      .call(xAxis)
      .selectAll("text")
      .style("text-anchor", "end")
      .attr("transform", "rotate(-45)");

    // Create Y axis
    const yAxis = d3.axisLeft(this.yScale).ticks(5);

    this.g.append("g").attr("class", "axis y-axis").call(yAxis);
  }

  // Add this method to your Histogram class
  async logQuery(query, context = "") {
    console.group(`DuckDB Query: ${context}`);
    console.log("SQL:", query);
    try {
      const result = await this.conn.query(query);
      console.log("Result:", result.toArray());
      console.groupEnd();
      return result;
    } catch (error) {
      console.error("Query Error:", error);
      console.groupEnd();
      throw error;
    }
  }
}
