declare module 'pokersolver' {
  /** 仅覆盖本适配器使用的 standard API；调用方负责传入合法、无重复的五张或七张牌。 */
  interface StandardHand {
    readonly rank: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    /** 按比牌重要性排列，可能超过五张；轮子中的 A 使用 rank=0。 */
    readonly cards: readonly {
      readonly rank: number;
      toString(): string;
    }[];
    /** 与项目 compare 相反：-1 表示当前手牌胜。 */
    compare(other: StandardHand): -1 | 0 | 1;
  }

  const solver: {
    readonly Hand: {
      solve(cards: string[], game: 'standard'): StandardHand;
    };
  };
  export default solver;
}
