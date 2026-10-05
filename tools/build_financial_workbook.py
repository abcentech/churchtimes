"""Build the review workbook. Requires xlsxwriter (development-only document tool)."""
from pathlib import Path
import math
import xlsxwriter

ROOT = Path(__file__).resolve().parents[1]
output = ROOT / 'public/downloads/churchtimes-operating-system.xlsx'
w = xlsxwriter.Workbook(output)
w.set_properties({'title':'Church Times Nigeria — proposed operating system','comments':'Planning assumptions only. Not company accounts.'})
head=w.add_format({'bold':True,'bg_color':'#173B32','font_color':'#F6F3EA','text_wrap':True,'valign':'vcenter'})
label=w.add_format({'bold':True,'font_color':'#173B32','text_wrap':True})
note=w.add_format({'font_color':'#61675E','text_wrap':True,'valign':'top'})
input_money=w.add_format({'bg_color':'#EAF1FF','num_format':'"₦"#,##0;[Red]("₦"#,##0)'})
input_number=w.add_format({'bg_color':'#EAF1FF','num_format':'0'})
input_percent=w.add_format({'bg_color':'#EAF1FF','num_format':'0%'})
input_text=w.add_format({'bg_color':'#EAF1FF','text_wrap':True})
money=w.add_format({'num_format':'"₦"#,##0;[Red]("₦"#,##0)'})
percent=w.add_format({'num_format':'0.0%'})
negative=w.add_format({'bg_color':'#F6D8CC','font_color':'#8A3523'})
positive=w.add_format({'bg_color':'#DFE5D8','font_color':'#173B32'})

def sheet(name,widths):
 s=w.add_worksheet(name);s.hide_gridlines(2);s.freeze_panes(3,1)
 for column,width in widths.items():s.set_column(column,width)
 return s

s=sheet('Read me',{'A:A':30,'B:B':100})
s.merge_range('A1:B1','CHURCH TIMES NIGERIA · PROPOSED OPERATING SYSTEM',head);s.set_row(0,30)
notes=[('Status','Planning template, not actual accounts or a forecast. Blue cells are editable. Formula cells are not protected; do not overwrite them unintentionally.'),('Model','Monthly revenue, contribution and break-even membership. Defaults are unvalidated hypotheses. Revenue is not collected cash. Excludes taxes, payment fees and bad debt until separately added.'),('Cash 13 weeks','Enter actual receipts and payments by due week. Defaults show zero receipts and an estimated weekly fixed-cost allocation. Replace the smoothed cost estimate with actual payment dates and amounts. Negative cash flags required funding; positive cash does not prove profitability.'),('Pipeline','Enter permissioned prospects only. Suggested stage probabilities are not forecasts. Weighted proposals are neither earned revenue nor cash. No real contacts are included.'),('Special edition','Verify the founder’s provisional ₦2m against a fresh quote. Adjust contingency, tax and commissions as necessary. Commit production only when cleared cash covers all approved committed costs, and signed terms/rights/capacity are confirmed.'),('Dashboard','Actual monthly values are blank/zero placeholders. Populate from reconciled bank/accounting and member records. Cash runway is simplified; use the dated 13-week forecast for decisions.'),('Privacy','Keep the completed workbook in an access-controlled company location. Do not put credentials or payment-card details here. Consent source and opt-out records must be respected.'),('Governance','Founder/editor guards mission; commercial lead owns sales and collections; digital owner operates distribution; bookkeeper reconciles. Have a second person review material spending and conflicts.'),('Next step','Approve owners, actual starting cash, costs, legal name, tax treatment, contact-list permissions, and current website/CMS manager. See docs/financial-plan.md and docs/research-and-discovery.md.')]
for row,(a,b) in enumerate(notes,3):s.write(row,0,a,label);s.write(row,1,b,note);s.set_row(row,66)

s=sheet('Model',{'A:A':40,'B:B':24,'D:D':44,'E:E':24})
s.merge_range('A1:E1','MONTHLY SCENARIO · HYPOTHESES, NOT ACTUAL ACCOUNTS',head);s.set_row(0,30)
inputs=[('Paying members',200,input_number),('Membership fee',2500,input_money),('Paying sponsors',2,input_number),('Fee per sponsor',200000,input_money),('Project revenue',300000,input_money),('Fixed costs',850000,input_money),('Member delivery rate',.1,input_percent),('Sponsor delivery rate',.2,input_percent),('Project delivery rate',.45,input_percent)]
for row,(name,value,fmt) in enumerate(inputs,3):s.write(row,0,name,label);s.write(row,1,value,fmt)
s.data_validation('B4:B4',{'validate':'integer','criteria':'>=','value':0});s.data_validation('B6:B6',{'validate':'integer','criteria':'>=','value':0})
for rng in ['B5','B7:B9']:s.data_validation(rng,{'validate':'decimal','criteria':'>=','value':0})
s.data_validation('B10:B12',{'validate':'decimal','criteria':'between','minimum':0,'maximum':1})
formulas=[('Gross revenue','=B4*B5+B6*B7+B8',1200000,money),('Delivery costs','=B4*B5*B10+B6*B7*B11+B8*B12',265000,money),('Contribution','=E4-E5',935000,money),('Operating result','=E6-B9',85000,money),('Operating margin','=IF(E4=0,0,E7/E4)',85000/1200000,percent),('Break-even members','=IF(MAX(0,B9-B6*B7*(1-B11)-B8*(1-B12))=0,0,IF(B5*(1-B10)>0,ROUNDUP(MAX(0,B9-B6*B7*(1-B11)-B8*(1-B12))/(B5*(1-B10)),0),"Not attainable"))',163,None),('3-month fixed-cost reserve','=B9*3',2550000,money)]
for row,(name,formula,value,fmt) in enumerate(formulas,3):s.write(row,3,name,label);s.write_formula(row,4,formula,fmt,value)
s.conditional_format('E7',{'type':'cell','criteria':'<','value':0,'format':negative});s.conditional_format('E7',{'type':'cell','criteria':'>=','value':0,'format':positive})
s.merge_range('A15:E17','Baseline: ₦85,000 operating surplus before excluded costs; 163 members to break even if sponsors/projects repeat. This is fragile. The contact list, actual cash and willingness to pay are unknown. Revenue does not equal receipts.',note)

s=sheet('Cash 13 weeks',{'A:A':12,'B:I':23})
s.merge_range('A1:I1','CASH FORECAST · INPUT COLLECTED RECEIPTS AND DATED PAYMENTS',head);s.set_row(0,30)
s.write('A2','Opening cash',label);s.write('B2',0,input_money);s.merge_range('C2:I2','Zero placeholder. Enter unrestricted bank cash; keep client delivery/tax funds separate.',note)
headers=['Week','Opening cash','Collected receipts','Fixed payments','Project / other payments','Closing cash','Funding needed','Receipt / expense notes','Owner']
s.write_row(2,0,headers,head);s.set_row(2,40)
closing=0
for row in range(3,16):
 excel=row+1;week=row-2;s.write(row,0,week)
 opening=closing;s.write_formula(row,1,'=$B$2' if row==3 else f'=F{excel-1}',money,opening)
 s.write(row,2,0,input_money)
 cost=850000*12/52;s.write_formula(row,3,'=Model!$B$9*12/52',input_money,cost)
 s.write(row,4,0,input_money)
 closing=opening-cost;s.write_formula(row,5,f'=B{excel}+C{excel}-D{excel}-E{excel}',money,closing)
 s.write_formula(row,6,f'=MAX(0,-F{excel})',money,max(0,-closing));s.write_blank(row,7,None,input_text);s.write_blank(row,8,None,input_text)
s.data_validation('C4:E16',{'validate':'decimal','criteria':'>=','value':0})
s.conditional_format('F4:F16',{'type':'cell','criteria':'<','value':0,'format':negative})
s.merge_range('A19:I21','Fixed payments are initially spread evenly from the Model sheet for illustration. Replace blue cells with actual due-date amounts; enter project/tax/fees/refunds separately. Zero receipts and zero starting cash intentionally show a funding shortfall, not a prediction. Do not substitute invoices for collected cash.',note)

s=sheet('Pipeline',{'A:B':23,'C:C':22,'D:E':23,'F:H':20,'I:J':24,'K:M':28})
s.merge_range('A1:M1','PERMISSIONED SALES PIPELINE · NO REAL CONTACTS INCLUDED',head);s.set_row(0,30)
headers=['Organisation','Contact / permission','Offer','Stage','Proposed amount','Probability','Weighted proposal','Cash collected','Delivery cost estimate','Next action date','Next action','Owner','Renewal / restrictions']
s.write_row(2,0,headers,head);s.set_row(2,38)
for row in range(3,23):
 for col in range(13):s.write_blank(row,col,None,input_text)
 s.write(row,4,0,input_money);s.write(row,5,0,input_percent);s.write_formula(row,6,f'=E{row+1}*F{row+1}',money,0);s.write(row,7,0,input_money);s.write(row,8,0,input_money)
s.data_validation('D4:D23',{'validate':'list','source':['Prospect','Discovery','Qualified','Proposal','Contract','Invoice','Paid','Delivered','Renewal','Lost']})
s.data_validation('F4:F23',{'validate':'decimal','criteria':'between','minimum':0,'maximum':1})
for rng in ['E4:E23','H4:I23']:s.data_validation(rng,{'validate':'decimal','criteria':'>=','value':0})
s.write('D25','Totals (not earned revenue)',label)
for col,letter in [(4,'E'),(6,'G'),(7,'H'),(8,'I')]:s.write_formula(24,col,f'=SUM({letter}4:{letter}23)',money,0)
s.merge_range('A28:M30','Probabilities are planning estimates only. Signed proposals and weighted pipeline are not cash. Record permission/source, written terms, a named next action and collections. Sponsor influence over independent reporting is prohibited. No personal data should be imported without a lawful purpose and appropriate controls.',note)

s=sheet('Special edition',{'A:A':48,'B:B':25,'D:D':45})
s.merge_range('A1:D1','PRINT PROJECT · CASH GATE BEFORE PRODUCTION',head);s.set_row(0,30)
for row,(name,value,fmt) in enumerate([('Verified all-in cost (provisional)',2000000,input_money),('Contingency rate',.15,input_percent),('Target margin on sales',.2,input_percent),('Cleared project cash',0,input_money)],3):s.write(row,0,name,label);s.write(row,1,value,fmt)
s.data_validation('B4',{'validate':'decimal','criteria':'>=','value':0});s.data_validation('B7',{'validate':'decimal','criteria':'>=','value':0});s.data_validation('B5:B6',{'validate':'decimal','criteria':'between','minimum':0,'maximum':.99})
for row,name,formula,val,fmt in [(9,'Committed cost + contingency','=B4*(1+B5)',2300000,money),(10,'Sales required for target margin','=B10/(1-B6)',2875000,money),(11,'Cash coverage gap','=MAX(0,B10-B7)',2300000,money),(12,'Funding gate','=IF(B7>=B10,"Cash covered; check other gates","HOLD: cash not covered")','HOLD: cash not covered',label)]:s.write(row,0,name,label);s.write_formula(row,1,formula,fmt,val)
s.merge_range('A16:D19','Gate is cash coverage plus signed terms, rights, capacity and independent editorial approval. ₦2m comes from the interview and is not a fresh quotation. Include tax, sales commission and delivery costs in the verified cost; if they depend on sales, revise the model before use. Do not spend deposits on unrelated operating losses.',note)

s=sheet('Dashboard',{'A:A':44,'B:B':25,'D:D':60})
s.merge_range('A1:D1','MONTHLY ACTUALS · ENTER RECONCILED RECORDS',head);s.set_row(0,30)
actuals=[('Unrestricted operating cash',0,input_money),('Monthly net cash burn',0,input_money),('Active paid members',0,input_number),('Members at start of month',0,input_number),('New paid members',0,input_number),('Cancelled / failed renewals',0,input_number),('Collected monthly receipts',0,input_money),('Largest sponsor receipts',0,input_money),('Overdue receivables',0,input_money)]
for row,(n,v,f) in enumerate(actuals,3):s.write(row,0,n,label);s.write(row,1,v,f)
for row,n,formula,value,fmt in [(14,'Cash runway (months)','=IF(B5>0,B4/B5,"Enter actual burn / not applicable")','Enter actual burn / not applicable',None),(15,'Monthly churn','=IF(B7>0,B9/B7,0)',0,percent),(16,'Largest sponsor concentration','=IF(B10>0,B11/B10,0)',0,percent),(17,'Expected closing member count','=B7+B8-B9',0,None),(18,'Member reconciliation difference','=B6-B18',0,None)]:s.write(row,0,n,label);s.write_formula(row,1,formula,fmt,value)
s.conditional_format('B17',{'type':'cell','criteria':'>','value':.25,'format':negative})
s.merge_range('D4:D12','Actual records are currently unknown. All zeros are placeholders, not verified results. Investigate any member reconciliation difference. Proposed concentration review trigger: 25%. Cash runway is meaningful only with realistic cash burn and exclusions for restricted funds.',note)
s.data_validation('B4:B12',{'validate':'decimal','criteria':'>=','value':0})
w.close()
print(output)
