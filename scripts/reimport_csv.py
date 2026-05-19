#!/usr/bin/env python3
"""Script de réimport automatique des données CSV vers Render"""
import pandas as pd, json, subprocess, xlrd, os
from datetime import datetime

PROXY = 'https://hostex-proxy.onrender.com'
CSV_DIR = os.path.expanduser('~/Desktop/csv')
BOOKING_XLS = '/tmp/booking.xls'

def conv(d):
    d=str(d).strip()
    if '/' in d:
        p=d.split('/')
        if len(p)==3: return f"{p[2]}-{p[0].zfill(2)}-{p[1].zfill(2)}"
    return d

def conv_fr(d):
    d=str(d).strip()
    mois={'janvier':'01','février':'02','mars':'03','avril':'04','mai':'05','juin':'06',
          'juillet':'07','août':'08','septembre':'09','octobre':'10','novembre':'11','décembre':'12'}
    p=d.lower().split()
    if len(p)==3 and p[1] in mois: return f"{p[2]}-{mois[p[1]]}-{p[0].zfill(2)}"
    return d

def valid(d):
    try: datetime.strptime(d,'%Y-%m-%d'); return True
    except: return False

# Vérifier si reimport nécessaire
r = json.loads(subprocess.check_output(['curl','-sk',f'{PROXY}/health']).decode())
stored = r.get('reservations_stored', 0)
print(f"DB actuelle: {stored} réservations")
if stored >= 300:
    print("DB OK, pas de réimport nécessaire")
    exit(0)

print("DB insuffisante, réimport en cours...")

# Airbnb
dfs=[pd.read_csv(f'{CSV_DIR}/{f}') for f in ['airbnb_.csv','airbnb_pending.csv']]
df_all=pd.concat(dfs,ignore_index=True)
df_all=df_all[df_all['Type']=='Réservation'].copy()
grouped={}
for _,r in df_all.iterrows():
    code=str(r.get('Code de confirmation','')).strip()
    if not code or code=='nan': continue
    ci=conv(r.get('Date de début','')); co=conv(r.get('Date de fin',''))
    if not valid(ci) or not valid(co): continue
    rev=float(str(r.get('Revenus bruts',0)).replace(',','.').replace(' ','') or 0)
    com=abs(float(str(r.get('Frais de service',0)).replace(',','.').replace(' ','') or 0))
    log=str(r.get('Logement','')).strip()
    if code not in grouped:
        grouped[code]={'reservation_code':code,'guest_name':str(r.get('Voyageur','')).strip(),
            'check_in_date':ci,'check_out_date':co,'channel_type':'airbnb',
            'property_id':'12619011' if 'Suite' in log else '12619012',
            'number_of_guests':1,'status':'accepted','total_price':rev,'commission':com,'currency':'EUR','_p':[rev]}
    else:
        grouped[code]['_p'].append(rev); grouped[code]['total_price']=round(sum(grouped[code]['_p']),2)
if 'HMTAPWHR2B' in grouped: grouped['HMTAPWHR2B']['total_price']=2501.96
for r in grouped.values(): r.pop('_p',None)
airbnb=list(grouped.values())

# Booking XLS
if not os.path.exists(BOOKING_XLS):
    booking_src = f'{CSV_DIR}/Réservations_2025-06-01_2026-11-30.xls'
    if os.path.exists(booking_src):
        subprocess.run(['cp', booking_src, BOOKING_XLS])

wb=xlrd.open_workbook(BOOKING_XLS)
ws=wb.sheet_by_index(0)
headers=[ws.cell_value(0,j) for j in range(ws.ncols)]
booking={}
for i in range(1,ws.nrows):
    row={headers[j]:ws.cell_value(i,j) for j in range(ws.ncols)}
    if str(row.get('Statut','')).strip().lower() in ['annulé','annulée','cancelled','no_show']: continue
    def xld(v):
        try:
            if isinstance(v,float): return xlrd.xldate_as_datetime(v,wb.datemode).strftime('%Y-%m-%d')
            return conv_fr(str(v))
        except: return str(v)
    ci=xld(row.get('Arrivée','')); co=xld(row.get('Départ',''))
    if not valid(ci) or not valid(co): continue
    num=str(int(row['Numéro de réservation']) if isinstance(row.get('Numéro de réservation'),float) else row.get('Numéro de réservation','')).strip()
    code=f"9-{num}-bk"
    booking[code]={'reservation_code':code,'guest_name':str(row.get('Nom du client','')).strip(),
        'check_in_date':ci,'check_out_date':co,'channel_type':'booking.com',
        'property_id':'12619011' if 'Suite' in str(row.get("Nom de l'établissement",'')) else '12619012',
        'number_of_guests':2,'status':'accepted',
        'total_price':float(row.get('Paiement total',0) or 0),
        'commission':float(row.get('Commission',0) or 0),'currency':'EUR'}

# Dédup
all_res={}
def prio(r):
    c=str(r.get('reservation_code',''))
    hm=c.startswith('HM') or c.startswith('0-') or (c.startswith('9-') and '-bk' not in c)
    return (0 if hm else 1,-float(r.get('total_price',0) or 0))
for r in sorted(airbnb+list(booking.values()),key=prio):
    key=f"{r['check_in_date']}_{r['property_id']}_{r['channel_type']}"
    if key not in all_res: all_res[key]=r

clean=list(all_res.values())
result=json.loads(subprocess.check_output([
    'curl','-sk','-X','POST',f'{PROXY}/import-csv',
    '-H','Content-Type: application/json',
    '-d',json.dumps({"reservations":clean})
]).decode())
print(f"Import: {result}")
