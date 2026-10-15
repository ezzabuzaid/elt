import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, session } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class NutritionLogStream extends PointStream {
  constructor() {
    super({
      type: 'nutrition-log',
      name: 'nutritionLog',
      named: true,
      shared: true,
      description:
        "One record per nutrition-log point Google Health holds for the user. Holds information about food logged by a user. There are two ways of creating a nutrition log based on the food type: 1. Identified food: Using the food field, which is a reference to a Food resource. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        energyKcal: {
          ...fields.number,
          description:
            'The energy value in kilocalories. Must be in the range `[0, 100000]`.',
        },
        energyUserProvidedUnit: {
          ...fields.text,
          description:
            'Value representing the user provided unit. One of JOULE, KILOJOULE, KILOCALORIE, SMALL_CALORIE, CALORIE.',
        },
        energyFromFatKcal: {
          ...fields.number,
          description:
            'The energy value in kilocalories. Must be in the range `[0, 100000]`.',
        },
        energyFromFatUserProvidedUnit: {
          ...fields.text,
          description:
            'Value representing the user provided unit. One of JOULE, KILOJOULE, KILOCALORIE, SMALL_CALORIE, CALORIE.',
        },
        food: {
          ...fields.text,
          description:
            'The resource name of the Food item. Required when creating a nutrition log from an identified food. For anonymous food logs, use the `food_display_name` field instead.',
        },
        foodDisplayName: {
          ...fields.text,
          description:
            'The display name of the food. For identified food logs, this is populated automatically from the referenced food.',
        },
        ...session.properties,
        mealType: {
          ...fields.text,
          description:
            'The meal category. One of `BREAKFAST`, `LUNCH`, `DINNER`, or `SNACK`. One of BEFORE_BREAKFAST, BREAKFAST, BEFORE_LUNCH, LUNCH, BEFORE_DINNER, DINNER, AFTER_DINNER, SNACK, ANYTIME.',
        },
        servingAmount: {
          ...fields.number,
          description: 'The number of servings.',
        },
        servingFoodMeasurementUnit: {
          ...fields.text,
          description: 'Food measurement unit',
        },
        servingFoodMeasurementUnitDisplayName: {
          ...fields.text,
          description:
            'Legacy measurement unit for serving size in singular form (e.g. "piece", "gram").',
        },
        totalCarbohydrateGrams: {
          ...fields.number,
          description:
            'The weight value in grams. Must be in the range `[0, 100000]`.',
        },
        totalCarbohydrateUserProvidedUnit: {
          ...fields.text,
          description:
            'Value representing the user provided unit. One of GRAM, KILOGRAM, OUNCE, POUND, STONE, MILLIGRAM, MICROGRAM, NANOGRAM.',
        },
        totalFatGrams: {
          ...fields.number,
          description:
            'The weight value in grams. Must be in the range `[0, 100000]`.',
        },
        totalFatUserProvidedUnit: {
          ...fields.text,
          description:
            'Value representing the user provided unit. One of GRAM, KILOGRAM, OUNCE, POUND, STONE, MILLIGRAM, MICROGRAM, NANOGRAM.',
        },
      },
    });
  }

  protected row({ nutritionLog }: DataPoint) {
    return {
      energyKcal: finite(nutritionLog?.energy?.kcal),
      energyUserProvidedUnit: nutritionLog?.energy?.userProvidedUnit ?? null,
      energyFromFatKcal: finite(nutritionLog?.energyFromFat?.kcal),
      energyFromFatUserProvidedUnit:
        nutritionLog?.energyFromFat?.userProvidedUnit ?? null,
      food: nutritionLog?.food ?? null,
      foodDisplayName: nutritionLog?.foodDisplayName ?? null,
      ...session.row(nutritionLog?.interval),
      mealType: nutritionLog?.mealType ?? null,
      servingAmount: finite(nutritionLog?.serving?.amount),
      servingFoodMeasurementUnit:
        nutritionLog?.serving?.foodMeasurementUnit ?? null,
      servingFoodMeasurementUnitDisplayName:
        nutritionLog?.serving?.foodMeasurementUnitDisplayName ?? null,
      totalCarbohydrateGrams: finite(nutritionLog?.totalCarbohydrate?.grams),
      totalCarbohydrateUserProvidedUnit:
        nutritionLog?.totalCarbohydrate?.userProvidedUnit ?? null,
      totalFatGrams: finite(nutritionLog?.totalFat?.grams),
      totalFatUserProvidedUnit:
        nutritionLog?.totalFat?.userProvidedUnit ?? null,
    };
  }
}
