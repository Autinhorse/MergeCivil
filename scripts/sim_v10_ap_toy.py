import sys, random
# 抽象模拟 v10-AP：建筑按人口增长自动到来（不花行动力），行动力只花在移动凑合并、买地上。
FOOT=[1,2,4,6,9,12,16,20,25]
B={'house':dict(food=-2,gold=1,cap=3),'farm':dict(food=4,wk=1),'quarry':dict(mat=3,wk=1),
   'mine':dict(ind=3,wk=1,hap=-1),'shop':dict(ind=-1,gold=4,wk=1),'theatre':dict(gold=-2,hap=3,wk=1)}
PG,CG=1.3,1.2
def row(t,l):
    r={}
    for k,v in B[t].items():
        g=PG if (v>0 and k!='wk') else CG
        r[k]=v*3**(l-1)*g**(l-1)
    return r
def run(seed,skill,grow,ap_base=5,ap_era=1,arr_k=4.0,refund=1.0,land_gold=1.0):
    # skill: 新建筑落地就自动凑成组的概率；拥挤时额外移动次数也随 skill 下降
    random.seed(seed)
    blds={}; pop=6.0; plots=1; era=1; st=dict(gold=10,mat=0,ind=0)
    owed=0.0; log=dict(apMerge=0,apLand=0,apWaste=0,merges=0,auto=0,lost=0,blocked=0)
    for turn in range(1,401):
        dp=1+grow*turn; pop+=dp; maxl=min(2+era,9)
        tot={k:0.0 for k in ['food','mat','ind','gold','wk','hap','cap']}
        for (t,l),n in blds.items():
            for k,v in row(t,l).items(): tot[k]+=v*n
        homeless=max(0,pop-tot['cap'])
        eff=min(1,pop/max(tot['wk'],1e-9))
        hap=tot['hap']-homeless*0.5
        mult=1 if hap>=0 else (0.9 if hap>=-10 else 0.75)
        net={}
        for k in ['food','mat','ind','gold']:
            p=sum(max(0,row(t,l).get(k,0))*n for (t,l),n in blds.items())
            c=sum(min(0,row(t,l).get(k,0))*n for (t,l),n in blds.items())
            net[k]=p*eff*mult+c
        hap-=max(0,-net['food'])*0.5
        for k in ['mat','ind','gold']: st[k]=max(0,st[k]+net[k])
        area=sum(FOOT[l-1]*n for (t,l),n in blds.items()); capA=plots*64
        if hap<-20: return turn,log,era,plots
        need=40*4**(era-1)
        if st['mat']>=need and st['ind']>=need*0.5 and era<7:
            st['mat']-=need; st['ind']-=need*0.5; era+=1
        # 新建筑到来：数量跟人口增长挂钩
        owed+=dp/arr_k
        while owed>=1:
            owed-=1
            if homeless>0 or (net['food']>4 and tot['cap']-pop<3): c='house'
            elif net['food']<2: c='farm'
            elif hap<2: c='theatre'
            elif st['mat']<need: c=random.choice(['quarry','mine'])
            else: c=random.choice(['shop','quarry','mine','farm'])
            if area+1>capA: log['lost']+=1; continue
            blds[(c,1)]=blds.get((c,1),0)+1; area+=1
            if c=='house': tot['cap']+=3; homeless=max(0,pop-tot['cap'])
            if c=='farm': net['food']+=4
            # 落地即自动合并
            if blds[(c,1)]>=3 and random.random()<skill:
                blds[(c,1)]-=3; blds[(c,2)]=blds.get((c,2),0)+1; area+=FOOT[1]-3; log['auto']+=1
        ap=ap_base+ap_era*(era-1)
        # 买地：行动力 5,7,9...
        apLand=5+2*(plots-1); gLand=20*2**(plots-1)*land_gold
        if area>capA*0.6 and ap>=apLand and st['gold']>=gLand:
            ap-=apLand; st['gold']-=gLand; plots+=1; capA+=64; log['apLand']+=apLand
        # 手动合并：挪 1 座 + 拥挤造成的额外挪动；返还被合建筑格数
        while True:
            cands=[(t,l) for (t,l),n in blds.items() if n>=3 and l<maxl]
            if not cands: break
            t,l=min(cands,key=lambda x:x[1])
            crowd=area/capA
            moves=1+int(crowd*4*(1-skill))
            cost=moves*FOOT[l-1]
            if ap<cost: log['blocked']+=1; break
            ap-=cost; ap+=FOOT[l-1]*refund; log['apMerge']+=cost-FOOT[l-1]*refund
            blds[(t,l)]-=3; blds[(t,l+1)]=blds.get((t,l+1),0)+1
            area+=FOOT[l]-3*FOOT[l-1]; log['merges']+=1
        log['apWaste']+=ap
    return 400,log,era,plots
if __name__=='__main__':
    for grow in [0.05,0.1]:
        for skill in [0.2,0.5,0.8]:
            rs=[run(s,skill,grow) for s in range(20)]
            T=[r[0] for r in rs]; L=rs[0][1]
            bl=sum(r[1]['blocked'] for r in rs)/20; lost=sum(r[1]['lost'] for r in rs)/20
            print(f"增速{grow} 技术{skill}: 存活 avg {sum(T)/20:.0f} ({min(T)}-{max(T)})  行动力卡住合并 {bl:.0f} 回合  放不下丢弃 {lost:.0f} 座  时代 {sum(r[2] for r in rs)/20:.1f} 地块 {sum(r[3] for r in rs)/20:.1f}")
