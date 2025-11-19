#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const REQUIRED_AREA_FIELDS = ['name', 'x', 'y', 'width', 'height', 'matchField'];

function printUsage() {
  console.log(`Usage: node scripts/validateAreas.js --data <data.json> [--areas interactiveAreas.json]

Options:
  --data, -d    Path to JSON file with the data used on the map (required)
  --areas, -a   Path to interactiveAreas.json (default: interactiveAreas.json)`);
}

function parseArgs(argv) {
  const options = {
    areas: 'interactiveAreas.json',
    data: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--areas':
      case '-a': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('Expected a value after --areas/-a');
        }
        options.areas = value;
        i += 1;
        break;
      }
      case '--data':
      case '-d': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('Expected a value after --data/-d');
        }
        options.data = value;
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.data) {
    throw new Error('Path to data file is required. Pass it via --data.');
  }

  return options;
}

function readFile(filePath, description) {
  const resolved = path.resolve(filePath);
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${description} at ${resolved}: ${error.message}`);
  }
}

function parseJsonArray(rawContent, description) {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new Error(`${description} is empty.`);
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`${description} must be a JSON array.`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${description}: ${error.message}`);
  }
}

function validateAreasShape(areas) {
  return areas.map((area, index) => {
    if (!area || typeof area !== 'object') {
      throw new Error(`Area #${index + 1} must be an object.`);
    }

    REQUIRED_AREA_FIELDS.forEach(field => {
      if (area[field] === undefined) {
        throw new Error(`Area #${index + 1} is missing required field "${field}".`);
      }
    });

    return area;
  });
}

function normalize(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function ensureDataObjects(dataArray) {
  return dataArray.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Data entry #${index + 1} must be an object.`);
    }
    return item;
  });
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const areasContent = readFile(options.areas, 'interactive areas file');
    const dataContent = readFile(options.data, 'data file');

    const areas = validateAreasShape(parseJsonArray(areasContent, 'interactive areas')); 
    const data = ensureDataObjects(parseJsonArray(dataContent, 'data array'));

    const warnings = [];

    areas.forEach((area, index) => {
      const rawField = area.matchField;
      const rawValue = area.matchValue !== undefined ? area.matchValue : area.name;

      const matchField = typeof rawField === 'string' ? rawField.trim() : '';
      const matchValue = typeof rawValue === 'string' ? rawValue.trim() : '';

      if (!matchField) {
        warnings.push({
          area: area.name || `#${index + 1}`,
          message: 'matchField is missing or empty'
        });
        return;
      }

      if (!matchValue) {
        warnings.push({
          area: area.name || `#${index + 1}`,
          message: 'matchValue is missing or empty'
        });
        return;
      }

      const normalizedValue = normalize(matchValue);
      const hasMatch = data.some(item => {
        const candidate = item[matchField];
        if (candidate === undefined || candidate === null) {
          return false;
        }
        return normalize(candidate) === normalizedValue;
      });

      if (!hasMatch) {
        warnings.push({
          area: area.name || `#${index + 1}`,
          message: `Value "${matchValue}" not found in field "${matchField}"`
        });
      }
    });

    if (warnings.length === 0) {
      console.log('All matchField/matchValue combinations have matches in the provided data.');
    } else {
      console.warn('Some interactive areas do not have corresponding records in the data:');
      warnings.forEach(warning => {
        console.warn(` - ${warning.area}: ${warning.message}`);
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
