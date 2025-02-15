import { Histogram } from "../dist/small-multivis.js";

// Sample census data
const censusData = [
  { age: 25, gender: "F", income: 45000, education: "Bachelor" },
  { age: 32, gender: "M", income: 65000, education: "Master" },
  { age: 45, gender: "F", income: 85000, education: "PhD" },
  { age: 28, gender: "M", income: 55000, education: "Bachelor" },
  { age: 52, gender: "F", income: 95000, education: "Master" },
  { age: 19, gender: "M", income: 25000, education: "High School" },
  { age: 38, gender: "F", income: 75000, education: "Bachelor" },
  { age: 41, gender: "M", income: 80000, education: "Master" },
  { age: 29, gender: "F", income: 50000, education: "Bachelor" },
  { age: 35, gender: "M", income: 70000, education: "Master" },
];

async function initHistogram() {
  try {
    // Create histogram instance
    const histogram = new Histogram({
      width: 700,
      height: 400,
      margin: { top: 20, right: 30, bottom: 60, left: 50 },
      column: "age",
      colors: ["#69b3a2", "#404080"],
      selectionMode: "multiple",
      axis: true,
      showLabelsBelow: true,
      dataSource: censusData,
      dataFormat: "json",
    });

    // Initialize and attach to DOM
    await histogram.initialize();
    document.getElementById("histogram").appendChild(histogram.svg.node());

    // Update visualization
    await histogram.update();

    // Listen for selection changes
    histogram.on("selectionChanged", (selectedData) => {
      console.log("Selected data:", selectedData);
    });
  } catch (error) {
    console.error("Failed to initialize histogram:", error);
  }
}

// Start the visualization
initHistogram();
