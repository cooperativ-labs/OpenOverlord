type QueryKey = readonly unknown[];

interface QueryLike {
  queryKey: QueryKey;
}

interface QueryInvalidator {
  invalidateQueries(filters?: {
    queryKey?: QueryKey;
    predicate?: (query: QueryLike) => boolean;
  }): unknown;
}

export function isEverhourQueryKey(queryKey: QueryKey): boolean {
  return (
    (queryKey[0] === 'integrations' && queryKey[1] === 'everhour') ||
    (queryKey[0] === 'mission' && queryKey[2] === 'everhour')
  );
}

export function invalidateNonEverhourQueries(queryClient: QueryInvalidator): void {
  void queryClient.invalidateQueries({
    predicate: query => !isEverhourQueryKey(query.queryKey)
  });
}

export function invalidateMissionEverhourQueries(queryClient: QueryInvalidator): void {
  void queryClient.invalidateQueries({
    predicate: query => query.queryKey[0] === 'mission' && query.queryKey[2] === 'everhour'
  });
}
