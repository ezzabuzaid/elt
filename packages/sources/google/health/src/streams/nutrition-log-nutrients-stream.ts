import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { fields, finite } from '../health-fields.ts';
import { nameOf } from '../point-stream.ts';

export class NutritionLogNutrientsStream extends ChildStream {
  constructor() {
    super({
      parent: 'nutrition-log',
      name: 'nutritionLogNutrients',
      description:
        'One record per entry in the nutrients list of each nutrition-log point. Represents the quantity of a nutrient. Primary key nutritionLog and position. Reloaded whole on every run with its parent.',
      properties: {
        nutritionLog: {
          type: 'string',
          minLength: 1,
          description:
            'The nutrition-log point this entry belongs to: its resource name.',
        },
        position: {
          type: 'integer',
          minimum: 0,
          description: "The entry's place in the list, from 0.",
        },
        nutrient: {
          ...fields.text,
          description:
            'The nutrient type. One of BIOTIN, CAFFEINE, CALCIUM, CHLORIDE, CARBOHYDRATES, CHOLESTEROL, CHROMIUM, COPPER, DIETARY_FIBER, FOLIC_ACID, IODINE, IRON, MAGNESIUM, MANGANESE, MOLYBDENUM, MONOUNSATURATED_FAT, NIACIN, PANTOTHENIC_ACID, PHOSPHORUS, POLYUNSATURATED_FAT, POTASSIUM, PROTEIN, RIBOFLAVIN, SATURATED_FAT, SELENIUM, SODIUM, SUGAR, THIAMIN, TRANS_FAT, UNSATURATED_FAT, VITAMIN_A, VITAMIN_B12, VITAMIN_B6, VITAMIN_C, VITAMIN_D, VITAMIN_E, VITAMIN_K, ZINC, FOLATE.',
        },
        quantityGrams: {
          ...fields.number,
          description:
            'The weight value in grams. Must be in the range `[0, 100000]`.',
        },
        quantityUserProvidedUnit: {
          ...fields.text,
          description:
            'Value representing the user provided unit. One of GRAM, KILOGRAM, OUNCE, POUND, STONE, MILLIGRAM, MICROGRAM, NANOGRAM.',
        },
      },
      primaryKey: ['nutritionLog', 'position'],
    });
  }

  protected rows(point: DataPoint) {
    const nutritionLog = nameOf(point);
    return (point.nutritionLog?.nutrients ?? []).map((entry, position) => ({
      nutritionLog,
      position,
      nutrient: entry?.nutrient ?? null,
      quantityGrams: finite(entry?.quantity?.grams),
      quantityUserProvidedUnit: entry?.quantity?.userProvidedUnit ?? null,
    }));
  }
}
