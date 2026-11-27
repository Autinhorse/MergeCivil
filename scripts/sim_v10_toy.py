import sys, math, random
# 抽象模拟：不做格子摆放，只算占地面积；合并 = 同种同级凑满 3 座自动合并
FOOT=[1,2,4,6,9,12,16,20,25]
# 每种建筑 Lv1 的一行收支：food mat ind gold workers hap housing
B={
 'house':  dict(food=-2, gold=+1, hap=0, wk=0, cap=3),
 'farm':   dict(food=+4, wk=1),
 'quarry': dict(mat=+3, wk=1),
 'mine':   dict(ind=+3, wk=1, hap=-1),
 'shop':   dict(ind=-1, gold=+4, wk=1),
 'theatre':dict(gold=-2, hap=+3, wk=1),
}
PG=float(sys.argv[1]) if len(sys.argv)>1 else 1.3   # 产出系数
CG=float(sys.argv[2]) if len(sys.argv)>2 else 1.2   # 消耗系数
GROW=float(sys.argv[3]) if len(sys.argv)>3 else 0.1 # 每回合人口增量增速
def row(t,l):
    r={}
    for k,v in B[t].items():
        if k=='cap': r[k]=v*3**(l-1)*PG**(l-1)
        elif k=='wk': r[k]=v*3**(l-1)*CG**(l-1)
        elif v>0: r[k]=v*3**(l-1)*PG**(l-1)
        else: r[k]=v*3**(l-1)*CG**(l-1)
    return r
def run(seed,verbose=False):
    random.seed(seed)
    blds={}  # (type,lvl)->count
    pop=6.0; plots=1; era=1; st=dict(gold=10,mat=0,ind=0)
    hist=[]
    for turn in range(1,301):
        pop+=1+GROW*turn
        maxl=min(2+era,9)
        # 汇总
        tot={k:0.0 for k in ['food','mat','ind','gold','wk','hap','cap']}
        for (t,l),n in blds.items():
            for k,v in row(t,l).items(): tot[k]+=v*n
        workers=min(pop,tot['cap'])
        homeless=max(0,pop-tot['cap'])
        eff=min(1,workers/max(tot['wk'],1e-9)) if tot['wk']>0 else 1
        hap=tot['hap']-homeless*0.5
        mult=1 if hap>=0 else (0.9 if hap>=-10 else 0.75)
        food=tot['food']*(1 if tot['food']<0 else eff*mult)
        # food: houses consume regardless; producers scaled
        prod=lambda k: sum(max(0,row(t,l).get(k,0))*n for (t,l),n in blds.items())
        cons=lambda k: sum(min(0,row(t,l).get(k,0))*n for (t,l),n in blds.items())
        net={k:prod(k)*eff*mult+cons(k) for k in ['food','mat','ind','gold']}
        starve=max(0,-net['food'])
        hap-=starve*0.5
        for k in ['mat','ind','gold']: st[k]=max(0,st[k]+net[k])
        area=sum(FOOT[l-1]*n for (t,l),n in blds.items())
        hist.append((turn,round(pop),round(tot['cap']),round(net['food'],1),round(hap,1),era,plots,area,plots*64))
        if hap< -20:
            return turn,hist
        # 升级时代
        need=40*4**(era-1)
        if st['mat']>=need and st['ind']>=need*0.5 and era<7:
            st['mat']-=need; st['ind']-=need*0.5; era+=1
        # 买地
        pc=20*2**(plots-1)
        if area>plots*64*0.85 and st['gold']>=pc: st['gold']-=pc; plots+=1
        # 选卡：2 张，挑最缺的
        for _ in range(2):
            if area+1>plots*64: break
            if homeless>0 or net['food']>4 and tot['cap']-pop<3: c='house'
            elif net['food']<2: c='farm'
            elif hap<2: c='theatre'
            elif st['mat']<need: c=random.choice(['quarry','mine'])
            else: c=random.choice(['shop','quarry','mine','farm'])
            blds[(c,1)]=blds.get((c,1),0)+1; area+=1
            if c=='house': tot['cap']+=3
            if c=='farm': net['food']+=4
        # 合并
        changed=True
        while changed:
            changed=False
            for (t,l),n in list(blds.items()):
                if n>=3 and l<maxl:
                    blds[(t,l)]-=3; blds[(t,l+1)]=blds.get((t,l+1),0)+1; changed=True
    return 300,hist
res=[run(s)[0] for s in range(20)]
print('PG',PG,'CG',CG,'GROW',GROW,'存活回合 avg',sum(res)/len(res),'min',min(res),'max',max(res))
if '-v' in sys.argv:
    t,h=run(0)
    for x in h[::5]+[h[-1]]: print(x)
