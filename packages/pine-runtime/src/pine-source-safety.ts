export class UnsupportedPineFeatureError extends Error {
  readonly kind = 'unsupported-feature' as const;

  constructor(feature: string) {
    super(`${feature} is not supported; the run was stopped instead of using the chart's own data. / ${feature} пока не поддерживается: запуск остановлен, чтобы не подставить данные текущего графика вместо запрошенной серии.`);
    this.name = 'UnsupportedPineFeatureError';
  }
}
