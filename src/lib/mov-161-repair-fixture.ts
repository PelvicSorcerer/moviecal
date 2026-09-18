// Disposable MOV-161 acceptance-drill fixture: a deliberately broken pure
// function used only to exercise the dispatcher's bounded CI repair pass.
// Not referenced by any product code; safe to delete once the drill
// completes.
export function addRepairFixture(a: number, b: number): number {
  return a + b;
}
