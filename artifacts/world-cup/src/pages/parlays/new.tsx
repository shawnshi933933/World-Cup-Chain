import { useState, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useGetMarkets, useCreateParlay, useGetSettings, SelectedOutcome } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getGetParlaysQueryKey, getGetParlayStatsQueryKey } from "@workspace/api-client-react";

import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Trash2, Plus, ArrowRight, Save, Calculator, List } from "lucide-react";

interface DraftLeg {
  marketId: string;
  marketTitle: string;
  selectedOutcomes: SelectedOutcome[];
  splitRatio: number; // 0-100, percentage for first outcome. Only used when 2 outcomes selected.
}

export default function ParlayNew() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: markets, isLoading: marketsLoading } = useGetMarkets();
  const { data: settings } = useGetSettings();
  const createParlay = useCreateParlay();

  const [step, setStep] = useState(1);
  const [name, setName] = useState(`世界杯连战 - ${new Date().toLocaleDateString()}`);
  const [initialAmount, setInitialAmount] = useState<number>(100);
  const [legs, setLegs] = useState<DraftLeg[]>([]);

  // Calculate effective payout range across all legs
  const { totalOdds, worstCaseOdds, maxPayout } = useMemo(() => {
    let tOdds = 1;
    let wOdds = 1;

    legs.forEach(leg => {
      if (leg.selectedOutcomes.length === 0) return;

      if (leg.selectedOutcomes.length === 2) {
        // Effective multiplier per outcome = (ratio/100) × odds
        const r1 = leg.splitRatio / 100;
        const r2 = (100 - leg.splitRatio) / 100;
        const eff1 = r1 * leg.selectedOutcomes[0].odds;
        const eff2 = r2 * leg.selectedOutcomes[1].odds;
        tOdds *= Math.max(eff1, eff2);
        wOdds *= Math.min(eff1, eff2);
      } else {
        tOdds *= leg.selectedOutcomes[0].odds;
        wOdds *= leg.selectedOutcomes[0].odds;
      }
    });

    return {
      totalOdds: legs.length > 0 ? tOdds : 0,
      worstCaseOdds: legs.length > 0 ? wOdds : 0,
      maxPayout: legs.length > 0 ? initialAmount * tOdds : 0,
    };
  }, [legs, initialAmount]);

  const handleAddMarket = (market: any) => {
    if (legs.some(l => l.marketId === market.id)) return;
    setLegs([...legs, {
      marketId: market.id,
      marketTitle: market.title,
      selectedOutcomes: [],
      splitRatio: 50,
    }]);
  };

  const handleRemoveLeg = (index: number) => {
    setLegs(legs.filter((_, i) => i !== index));
  };

  const handleToggleOutcome = (legIndex: number, outcome: any) => {
    const leg = legs[legIndex];
    const isSelected = leg.selectedOutcomes.some(o => o.name === outcome.name);

    let newOutcomes;
    if (isSelected) {
      newOutcomes = leg.selectedOutcomes.filter(o => o.name !== outcome.name);
    } else {
      if (leg.selectedOutcomes.length >= 2) return;
      newOutcomes = [...leg.selectedOutcomes, {
        name: outcome.name,
        tokenId: outcome.tokenId || "",
        odds: outcome.odds,
        price: outcome.price,
      }];
    }

    const newLegs = [...legs];
    newLegs[legIndex] = { ...leg, selectedOutcomes: newOutcomes, splitRatio: 50 };
    setLegs(newLegs);
  };

  const handleSplitRatioChange = (legIndex: number, value: number) => {
    const newLegs = [...legs];
    newLegs[legIndex] = { ...newLegs[legIndex], splitRatio: value };
    setLegs(newLegs);
  };

  const handleSubmit = () => {
    if (legs.length === 0 || legs.some(l => l.selectedOutcomes.length === 0)) {
      toast({ title: "错误", description: "请确保每个比赛都至少选择了一个结果", variant: "destructive" });
      return;
    }
    if (initialAmount <= 0) {
      toast({ title: "错误", description: "请输入有效的初始金额", variant: "destructive" });
      return;
    }

    createParlay.mutate({
      data: {
        name,
        initialAmount,
        simulationMode: settings?.simulationMode ?? true,
        legs: legs.map(l => ({
          marketId: l.marketId,
          marketTitle: l.marketTitle,
          selectedOutcomes: l.selectedOutcomes.map((o, i) => ({
            ...o,
            ratio: l.selectedOutcomes.length === 2
              ? (i === 0 ? l.splitRatio : 100 - l.splitRatio)
              : 100,
          })),
        })),
      },
    }, {
      onSuccess: (parlay) => {
        toast({ title: "串关创建成功!" });
        queryClient.invalidateQueries({ queryKey: getGetParlaysQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetParlayStatsQueryKey() });
        setLocation(`/parlays/${parlay.id}`);
      },
      onError: (err: any) => {
        toast({ title: "创建失败", description: err.message || "未知错误", variant: "destructive" });
      },
    });
  };

  const isNextDisabled = step === 1 && (legs.length === 0 || legs.some(l => l.selectedOutcomes.length === 0));

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-black font-serif tracking-tight">新建战役</h1>
        <div className="flex items-center gap-2 mt-2">
          <Badge variant={step >= 1 ? "default" : "outline"} className={step >= 1 ? "bg-primary text-primary-foreground" : ""}>1. 选择比赛</Badge>
          <div className={`h-1 w-8 ${step >= 2 ? "bg-primary" : "bg-border"}`}></div>
          <Badge variant={step >= 2 ? "default" : "outline"} className={step >= 2 ? "bg-primary text-primary-foreground" : ""}>2. 设置金额</Badge>
          <div className={`h-1 w-8 ${step >= 3 ? "bg-primary" : "bg-border"}`}></div>
          <Badge variant={step >= 3 ? "default" : "outline"} className={step >= 3 ? "bg-primary text-primary-foreground" : ""}>3. 确认创建</Badge>
        </div>
      </div>

      {step === 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Market picker */}
          <div className="lg:col-span-7 space-y-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Plus className="w-5 h-5 text-primary" />
              添加比赛
            </h2>
            <div className="bg-card/50 border border-border/50 rounded-xl p-4 max-h-[600px] overflow-y-auto">
              {marketsLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map(i => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
                </div>
              ) : markets?.filter(m => m.active).map(market => (
                <div key={market.id} className="flex justify-between items-center p-3 border-b border-border/50 last:border-0 hover:bg-muted/50 rounded-lg transition-colors">
                  <div>
                    <div className="font-medium">{market.title}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {market.outcomes.map(o => `${o.name} 1赔${o.odds.toFixed(2)}`).join(" | ")}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleAddMarket(market)}
                    disabled={legs.some(l => l.marketId === market.id)}
                  >
                    添加
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Selected legs */}
          <div className="lg:col-span-5 space-y-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <List className="w-5 h-5 text-primary" />
              已选串关 ({legs.length})
            </h2>

            <div className="space-y-4">
              {legs.length === 0 ? (
                <div className="text-center p-8 border border-dashed rounded-xl text-muted-foreground">
                  请从左侧选择比赛添加到串关中
                </div>
              ) : legs.map((leg, index) => {
                const market = markets?.find(m => m.id === leg.marketId);
                const hasSplit = leg.selectedOutcomes.length === 2;
                const stake1 = hasSplit ? Math.round(initialAmount * leg.splitRatio) / 100 : initialAmount;
                const stake2 = hasSplit ? Math.round(initialAmount * (100 - leg.splitRatio)) / 100 : 0;

                return (
                  <Card key={leg.marketId} className="border-primary/20">
                    <CardHeader className="p-4 pb-2 flex flex-row items-start justify-between">
                      <CardTitle className="text-base font-bold leading-tight">{leg.marketTitle}</CardTitle>
                      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => handleRemoveLeg(index)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </CardHeader>
                    <CardContent className="p-4 pt-0 space-y-3">
                      <div className="text-xs text-muted-foreground">选择结果 (最多2个):</div>
                      <div className="grid grid-cols-2 gap-2">
                        {market?.outcomes.map(outcome => {
                          const isSelected = leg.selectedOutcomes.some(o => o.name === outcome.name);
                          const isDisabled = !isSelected && leg.selectedOutcomes.length >= 2;
                          return (
                            <div
                              key={outcome.name}
                              className={`flex items-center space-x-2 border rounded p-2 cursor-pointer transition-colors ${
                                isSelected ? "border-primary bg-primary/10" :
                                isDisabled ? "opacity-50 cursor-not-allowed border-border/50" : "border-border/50 hover:border-primary/50"
                              }`}
                              onClick={() => !isDisabled && handleToggleOutcome(index, outcome)}
                            >
                              <Checkbox checked={isSelected} disabled={isDisabled} />
                              <Label className="flex-1 cursor-pointer flex justify-between items-center text-sm">
                                <span>{outcome.name}</span>
                                <span className="font-bold text-primary">1赔{outcome.odds.toFixed(2)}</span>
                              </Label>
                            </div>
                          );
                        })}
                      </div>

                      {/* Split ratio slider — shown only when 2 outcomes selected */}
                      {hasSplit && (
                        <div className="pt-1 space-y-2 border-t border-border/30 mt-2">
                          <div className="flex justify-between items-center text-[11px] text-muted-foreground font-medium">
                            <span>{leg.selectedOutcomes[0].name}</span>
                            <span className="text-primary/60">← 比例调整 →</span>
                            <span>{leg.selectedOutcomes[1].name}</span>
                          </div>
                          <Slider
                            min={10}
                            max={90}
                            step={5}
                            value={[leg.splitRatio]}
                            onValueChange={([val]) => handleSplitRatioChange(index, val)}
                          />
                          <div className="flex justify-between items-center text-xs font-bold">
                            <span className="text-primary">{leg.splitRatio}% · ${stake1.toFixed(0)}</span>
                            <span className="text-primary">${stake2.toFixed(0)} · {100 - leg.splitRatio}%</span>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            <div className="pt-4 flex justify-end">
              <Button size="lg" onClick={() => setStep(2)} disabled={isNextDisabled} className="w-full">
                下一步: 设置金额 <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <Card className="max-w-2xl mx-auto border-border/50 bg-card/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calculator className="w-5 h-5 text-primary" />
              设置投注信息
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">串关名称</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} className="text-lg font-bold bg-background" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">初始投注金额 (USDC)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 font-bold text-muted-foreground">$</span>
                <Input
                  id="amount"
                  type="number"
                  value={initialAmount}
                  onChange={(e) => setInitialAmount(Number(e.target.value))}
                  className="pl-8 text-xl font-black bg-background"
                />
              </div>
            </div>

            <div className="bg-muted rounded-xl p-6 mt-6 border border-border/50">
              <h3 className="font-bold mb-4 text-center">收益预测</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center">
                  <div className="text-sm text-muted-foreground mb-1">最佳有效赔率</div>
                  <div className="text-3xl font-black text-primary">×{totalOdds.toFixed(2)}</div>
                  {worstCaseOdds !== totalOdds && (
                    <div className="text-xs text-muted-foreground mt-1">最低: ×{worstCaseOdds.toFixed(2)}</div>
                  )}
                </div>
                <div className="text-center">
                  <div className="text-sm text-muted-foreground mb-1">最高可获得</div>
                  <div className="text-3xl font-black text-accent">${maxPayout.toFixed(2)}</div>
                </div>
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex justify-between border-t border-border/50 pt-6">
            <Button variant="outline" onClick={() => setStep(1)}>返回修改</Button>
            <Button size="lg" onClick={() => setStep(3)}>
              确认预览 <ArrowRight className="ml-2 w-4 h-4" />
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 3 && (
        <Card className="max-w-2xl mx-auto border-primary/50 shadow-lg shadow-primary/10">
          <CardHeader className="text-center pb-2">
            <Badge variant="outline" className="mx-auto mb-4 bg-primary/10 text-primary border-primary/20 text-sm">即将创建</Badge>
            <CardTitle className="text-3xl font-black">{name}</CardTitle>
            <div className="text-muted-foreground mt-2">包含 {legs.length} 场比赛</div>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div className="flex justify-between items-center p-4 bg-muted rounded-lg border border-border">
              <div>
                <div className="text-sm text-muted-foreground">初始金额</div>
                <div className="text-2xl font-black">${initialAmount.toFixed(2)}</div>
              </div>
              <ArrowRight className="w-6 h-6 text-muted-foreground" />
              <div className="text-right">
                <div className="text-sm text-muted-foreground">最高可获得</div>
                <div className="text-2xl font-black text-accent">${maxPayout.toFixed(2)}</div>
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="font-bold text-sm text-muted-foreground uppercase tracking-wider">比赛清单</h3>
              {legs.map((leg, i) => (
                <div key={i} className="flex items-start gap-4 text-sm bg-background p-3 rounded border border-border/50">
                  <div className="bg-primary/20 text-primary font-bold w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <div className="flex-1">
                    <div className="font-bold">{leg.marketTitle}</div>
                    {leg.selectedOutcomes.length === 2 ? (
                      <div className="text-muted-foreground mt-0.5">
                        <span className="text-primary font-medium">{leg.selectedOutcomes[0].name}</span>
                        {" "}{leg.splitRatio}% · ${Math.round(initialAmount * leg.splitRatio) / 100}
                        {" "}+ <span className="text-primary font-medium">{leg.selectedOutcomes[1].name}</span>
                        {" "}{100 - leg.splitRatio}% · ${Math.round(initialAmount * (100 - leg.splitRatio)) / 100}
                      </div>
                    ) : (
                      <div className="text-muted-foreground">
                        {leg.selectedOutcomes.map(o => `${o.name} (1赔${o.odds.toFixed(2)})`).join("")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-4 border-t border-border/50 pt-6">
            <Button
              size="lg"
              className="w-full h-14 text-lg font-bold"
              onClick={handleSubmit}
              disabled={createParlay.isPending}
            >
              {createParlay.isPending ? "创建中..." : "确认并创建战役"}
              {!createParlay.isPending && <Save className="ml-2 w-5 h-5" />}
            </Button>
            <Button variant="ghost" onClick={() => setStep(2)} className="w-full">返回修改</Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
