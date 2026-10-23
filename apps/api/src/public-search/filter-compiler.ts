import { UnprocessableEntityException } from '@nestjs/common';
import type { IndexField, PublicSearchRequest } from '@osc/contracts';

export function compilePublicFilters(
  fields: IndexField[],
  filters: NonNullable<PublicSearchRequest['filter']>,
): string {
  return filters
    .map((filter) => {
      const field = fields.find((candidate) => candidate.name === filter.field);
      if (!field?.facet) {
        throw new UnprocessableEntityException(
          `Field ${filter.field} is not filterable`,
        );
      }
      const numeric = ['int32', 'int64', 'float'].includes(field.type);
      if (filter.operator !== 'eq' && !numeric) {
        throw new UnprocessableEntityException(
          'Range operators require a numeric field',
        );
      }
      if (numeric && typeof filter.value !== 'number') {
        throw new UnprocessableEntityException(
          'Numeric filters require a number',
        );
      }
      if (field.type === 'bool' && typeof filter.value !== 'boolean') {
        throw new UnprocessableEntityException(
          'Boolean filters require a boolean',
        );
      }
      const operator = {
        eq: ':=',
        gt: ':>',
        gte: ':>=',
        lt: ':<',
        lte: ':<=',
      }[filter.operator];
      const value =
        typeof filter.value === 'string'
          ? `\`${filter.value.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``
          : String(filter.value);
      return `${filter.field}${operator}${value}`;
    })
    .join(' && ');
}
