import { useState } from "react";
import { useGetMarkets } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, RefreshCw, AlertCircle, Calendar } from "lucide-react";
import { useLocation } from "wouter";

function formatMatchDate(endDate: string | null | undefined): string {
  if (!endDate) return "";
  try {
    return new Date(endDate).toLocaleDateString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function Markets() {
  const [search, setSearch] = useState("");
  const [forceRefresh, setForceRefresh] = useState(false);
  const { data: markets, isLoading, refetch } = useGetMarkets({ search, refresh: forceRefresh || undefined });
  const [, setLocation] = useLocation();

  const handleRefresh = async () => {
    setForceRefresh(true);
    await refetch();
    setForceRefresh(false);
  };

  const handleCreateParlay = (marketId: string) => {
    setLocation(`/parlays/new?market=${marketId}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black font-serif tracking-tight">赛事市场</h1>
          <p className="text-muted-foreground mt-1">2026 世界杯小组赛 · 来自 Polymarket 的实时赔率</p>
        </div>

        <div className="flex w-full md:w-auto gap-2">
          <div className="relative w-full md:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="搜索球队..."
              className="pl-9 bg-card/50"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant="outline" size="icon" onClick={handleRefresh} title="强制刷新 Polymarket 数据">
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <Card key={i} className="animate-pulse bg-muted h-36 border-0" />
          ))}
        </div>
      ) : markets && markets.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {markets.map((market) => {
            const [home, away] = market.title.split(/ vs\.? /);
            const homeOutcome = market.outcomes.find(o => o.name !== "平局" && o.name.startsWith((home || "").substring(0, 3)));
            const drawOutcome = market.outcomes.find(o => o.name === "平局");
            const awayOutcome = market.outcomes.find(o => o.name !== "平局" && o.name.startsWith((away || "").substring(0, 3)));

            const displayOutcomes = homeOutcome && drawOutcome && awayOutcome
              ? [homeOutcome, drawOutcome, awayOutcome]
              : market.outcomes;

            return (
              <Card key={market.id} className="border-border/50 bg-card/50 hover:border-primary/50 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex justify-between items-start mb-1 gap-2">
                    <Badge variant={market.active ? "default" : "secondary"} className={market.active ? "bg-accent text-accent-foreground hover:bg-accent text-xs" : "text-xs"}>
                      {market.active ? "开放投注" : "已结束"}
                    </Badge>
                    {market.endDate && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="w-3 h-3" />
                        {formatMatchDate(market.endDate)}
                      </span>
                    )}
                  </div>
                  <CardTitle className="text-lg leading-tight">{market.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Win / Draw / Loss row */}
                  <div className="grid grid-cols-3 gap-2">
                    {displayOutcomes.map((outcome, idx) => (
                      <div
                        key={idx}
                        className="bg-background rounded-lg p-2 flex flex-col items-center justify-center text-center border border-border/50 min-h-[60px]"
                      >
                        <span className="text-[11px] text-muted-foreground leading-tight mb-1">{outcome.name}</span>
                        <span className="font-black text-primary text-base">1赔{outcome.odds.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>

                  <Button
                    className="w-full"
                    disabled={!market.active}
                    onClick={() => handleCreateParlay(market.id)}
                  >
                    添加到串关
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-20 bg-card/30 rounded-xl border border-dashed">
          <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-xl font-bold mb-2">未找到比赛</h3>
          <p className="text-muted-foreground">没有找到符合搜索条件的世界杯比赛。</p>
        </div>
      )}
    </div>
  );
}
