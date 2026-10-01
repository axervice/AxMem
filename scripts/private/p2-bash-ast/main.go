package main

import (
  "bytes"
  "crypto/sha256"
  "encoding/hex"
  "encoding/json"
  "fmt"
  "io"
  "os"
  "strings"
  "unicode/utf8"

  "mvdan.cc/sh/v3/syntax"
)

const (
  maxSource = 1 << 20
  maxDepth = 256
  maxNodes = 200000
  parserVersion = "mvdan.cc/sh/v3@v3.13.1"
  protocolVersion = "axmem-p2-bash-ast/v1"
)

type Span struct { Start uint `json:"start"`; End uint `json:"end"` }
type Call struct {
  Start uint `json:"start"`
  End uint `json:"end"`
  Command Span `json:"command"`
  CommandValue string `json:"commandValue"`
  FirstArgPresent bool `json:"firstArgPresent"`
  FirstArg Span `json:"firstArg"`
  FirstArgSource string `json:"firstArgSource"`
  ExactQuotedParam bool `json:"exactQuotedParam"`
  ParamName string `json:"paramName"`
}
type UnsupportedCommand struct {
  Start uint `json:"start"`
  End uint `json:"end"`
  Source string `json:"source"`
  Reason string `json:"reason"`
}
type Hdoc struct {
  Op string `json:"op"`
  Marker string `json:"marker"`
  Word Span `json:"word"`
  Body Span `json:"body"`
  Closing Span `json:"closing"`
  BodyBytes int `json:"bodyBytes"`
}
type RedirFact struct {
  Op string `json:"op"`
  Fd string `json:"fd"`
  Word Span `json:"word"`
  WordSource string `json:"wordSource"`
  ExactQuotedParam bool `json:"exactQuotedParam"`
  ParamName string `json:"paramName"`
  Hdoc *Hdoc `json:"hdoc"`
}
type HeredocStmt struct {
  Start uint `json:"start"`
  End uint `json:"end"`
  SimpleCall bool `json:"simpleCall"`
  Command Span `json:"command"`
  CommandStatic bool `json:"commandStatic"`
  CommandValue string `json:"commandValue"`
  ArgCount int `json:"argCount"`
  AssignCount int `json:"assignCount"`
  Redirs []RedirFact `json:"redirs"`
}
type Stats struct { Nodes int `json:"nodes"`; MaxDepth int `json:"maxDepth"` }
type Result struct {
  OK bool `json:"ok"`
  Protocol string `json:"protocol"`
  Parser string `json:"parser"`
  SourceBytes int `json:"sourceBytes"`
  SourceSHA256 string `json:"sourceSha256"`
  Calls []Call `json:"calls"`
  UnsupportedCommands []UnsupportedCommand `json:"unsupportedCommands"`
  Heredocs []Hdoc `json:"heredocs"`
  HeredocStatements []HeredocStmt `json:"heredocStatements"`
  Stats Stats `json:"stats"`
}
type Failure struct {
  OK bool `json:"ok"`
  Error string `json:"error"`
  Detail string `json:"detail"`
  Protocol string `json:"protocol"`
  Parser string `json:"parser"`
  SourceBytes int `json:"sourceBytes"`
  SourceSHA256 string `json:"sourceSha256"`
}

func fail(src []byte, code, detail string) {
  sum:=sha256.Sum256(src)
  _=json.NewEncoder(os.Stdout).Encode(Failure{OK:false,Error:code,Detail:detail,Protocol:protocolVersion,Parser:parserVersion,SourceBytes:len(src),SourceSHA256:hex.EncodeToString(sum[:])})
  os.Exit(2)
}
func spanOK(src []byte,p,e syntax.Pos)(uint,uint,bool){
  if p.IsRecovered() || e.IsRecovered(){return 0,0,false}
  if !p.IsValid() || !e.IsValid(){return 0,0,false}
  s,t:=p.Offset(),e.Offset()
  if s>t || t>uint(len(src)){return 0,0,false}
  return s,t,true
}
func optionalNodeSpanValid(src []byte,n syntax.Node) bool {
  p,e:=n.Pos(),n.End()
  if p.IsRecovered() || e.IsRecovered(){return false}
  if p.IsValid() && p.Offset()>uint(len(src)){return false}
  if e.IsValid() && e.Offset()>uint(len(src)){return false}
  if p.IsValid() && e.IsValid() && p.Offset()>e.Offset(){return false}
  return true
}
func unescapeUnquotedLit(v string)(string,bool){
  var b strings.Builder
  for i:=0;i<len(v);i++{
    if v[i]=='\\'{
      if i+1>=len(v) || v[i+1]=='\n' || v[i+1]=='\r'{return "",false}
      i++
      b.WriteByte(v[i])
      continue
    }
    switch v[i]{
    case '*','?','[',']','{','}','~':
      return "",false
    }
    b.WriteByte(v[i])
  }
  return b.String(),true
}
func staticDoublePart(p syntax.WordPart)(string,bool){
  lit,ok:=p.(*syntax.Lit)
  if !ok || strings.Contains(lit.Value,"\\"){return "",false}
  return lit.Value,true
}
func staticWordPart(p syntax.WordPart)(string,bool){
  switch v:=p.(type){
  case *syntax.Lit:
    return unescapeUnquotedLit(v.Value)
  case *syntax.SglQuoted:
    if v.Dollar{return "",false}
    return v.Value,true
  case *syntax.DblQuoted:
    if v.Dollar{return "",false}
    var b strings.Builder
    for _,sub:=range v.Parts{
      s,ok:=staticDoublePart(sub)
      if !ok{return "",false}
      b.WriteString(s)
    }
    return b.String(),true
  default:
    return "",false
  }
}
func staticWord(w *syntax.Word)(string,bool){
  if w==nil || len(w.Parts)==0{return "",false}
  if len(w.Parts)==1{
    if lit,ok:=w.Parts[0].(*syntax.Lit);ok && (lit.Value=="[" || lit.Value=="]"){
      return lit.Value,true
    }
  }
  var b strings.Builder
  for _,p:=range w.Parts{
    s,ok:=staticWordPart(p)
    if !ok{return "",false}
    b.WriteString(s)
  }
  return b.String(),true
}
func exactQuotedParam(w *syntax.Word)(bool,string){
  if w==nil || len(w.Parts)!=1{return false,""}
  dq,ok:=w.Parts[0].(*syntax.DblQuoted)
  if !ok || dq.Dollar || len(dq.Parts)!=1{return false,""}
  pe,ok:=dq.Parts[0].(*syntax.ParamExp)
  if !ok || !pe.Short || pe.Param==nil || pe.Param.Value==""{return false,""}
  if pe.Excl || pe.Length || pe.Width || pe.IsSet || pe.Index!=nil || pe.NestedParam!=nil || len(pe.Modifiers)!=0{return false,""}
  return true,pe.Param.Value
}
func buildHdoc(src []byte,r *syntax.Redirect)(Hdoc,string){
  if r.Op!=syntax.Hdoc{return Hdoc{},"unsupported-heredoc"}
  if r.Word==nil || len(r.Word.Parts)!=1{return Hdoc{},"unsupported-heredoc"}
  sq,ok:=r.Word.Parts[0].(*syntax.SglQuoted)
  if !ok || sq.Dollar || sq.Value==""{return Hdoc{},"unsupported-heredoc"}
  ws,we,ok:=spanOK(src,r.Word.Pos(),r.Word.End());if !ok{return Hdoc{},"invalid-source-span"}
  if string(src[ws:we])!="'"+sq.Value+"'"{return Hdoc{},"unsupported-heredoc"}
  if r.Hdoc==nil || len(r.Hdoc.Parts)!=1{return Hdoc{},"unsupported-heredoc"}
  lit,ok:=r.Hdoc.Parts[0].(*syntax.Lit)
  if !ok || lit.Value==""{return Hdoc{},"unsupported-heredoc"}
  hs,he,ok:=spanOK(src,lit.Pos(),lit.End());if !ok{return Hdoc{},"invalid-source-span"}
  if bytes.IndexByte(src[hs:he],13)>=0{return Hdoc{},"unsupported-heredoc"}
  body:=[]byte(lit.Value);be:=hs+uint(len(body))
  if be>he || int(be)>len(src){return Hdoc{},"invalid-source-span"}
  if !bytes.Equal(src[hs:be],body){return Hdoc{},"heredoc-body-mismatch"}
  if !bytes.Equal(src[be:he],[]byte(sq.Value)){return Hdoc{},"unsupported-heredoc"}
  return Hdoc{Op:r.Op.String(),Marker:sq.Value,Word:Span{Start:ws,End:we},Body:Span{Start:hs,End:be},Closing:Span{Start:be,End:he},BodyBytes:len(body)},""
}
func stmtFact(src []byte,s *syntax.Stmt)(HeredocStmt,string,bool){
  hasHdoc:=false
  for _,r:=range s.Redirs{
    if r.Op==syntax.Hdoc || r.Op==syntax.DashHdoc{hasHdoc=true;break}
  }
  if !hasHdoc{return HeredocStmt{},"",false}
  ss,se,ok:=spanOK(src,s.Pos(),s.End());if !ok{return HeredocStmt{},"invalid-source-span",true}
  out:=HeredocStmt{Start:ss,End:se,SimpleCall:false,Command:Span{Start:0,End:0},CommandStatic:false,CommandValue:"",ArgCount:0,AssignCount:0,Redirs:[]RedirFact{}}
  if c,ok:=s.Cmd.(*syntax.CallExpr);ok{
    out.SimpleCall=true
    out.ArgCount=len(c.Args)
    out.AssignCount=len(c.Assigns)
    if len(c.Args)>0{
      cs,ce,ok:=spanOK(src,c.Args[0].Pos(),c.Args[0].End());if !ok{return HeredocStmt{},"invalid-source-span",true}
      out.Command=Span{Start:cs,End:ce}
      if v,static:=staticWord(c.Args[0]);static{out.CommandStatic=true;out.CommandValue=v}
    }
  }
  for _,r:=range s.Redirs{
    if r.Word==nil{return HeredocStmt{},"invalid-source-span",true}
    ws,we,ok:=spanOK(src,r.Word.Pos(),r.Word.End());if !ok{return HeredocStmt{},"invalid-source-span",true}
    fd:=""
    if r.N!=nil{fd=r.N.Value}
    rf:=RedirFact{Op:r.Op.String(),Fd:fd,Word:Span{Start:ws,End:we},WordSource:string(src[ws:we]),ExactQuotedParam:false,ParamName:"",Hdoc:nil}
    rf.ExactQuotedParam,rf.ParamName=exactQuotedParam(r.Word)
    if r.Op==syntax.Hdoc || r.Op==syntax.DashHdoc{
      h,code:=buildHdoc(src,r);if code!=""{return HeredocStmt{},code,true}
      rf.Hdoc=&h
    }
    out.Redirs=append(out.Redirs,rf)
  }
  return out,"",true
}
func main(){
  src,err:=io.ReadAll(io.LimitReader(os.Stdin,maxSource+1))
  if err!=nil{fail(src,"read-error",err.Error())}
  if len(src)>maxSource{fail(src,"source-limit","source exceeds 1 MiB")}
  if !utf8.Valid(src){fail(src,"invalid-utf8","source is not valid UTF-8")}
  if bytes.IndexByte(src,0)>=0{fail(src,"nul-byte","NUL is not accepted")}

  f,err:=syntax.NewParser().Parse(bytes.NewReader(src),"stdin")
  if err!=nil{fail(src,"parse-error",err.Error())}

  res:=Result{OK:true,Protocol:protocolVersion,Parser:parserVersion,SourceBytes:len(src),Calls:[]Call{},UnsupportedCommands:[]UnsupportedCommand{},Heredocs:[]Hdoc{},HeredocStatements:[]HeredocStmt{}}
  sum:=sha256.Sum256(src);res.SourceSHA256=hex.EncodeToString(sum[:])
  depth:=0
  bad:=""
  syntax.Walk(f,func(n syntax.Node)bool{
    if n==nil{depth--;return true}
    depth++;res.Stats.Nodes++
    if depth>res.Stats.MaxDepth{res.Stats.MaxDepth=depth}
    if res.Stats.Nodes>maxNodes && bad==""{bad="node-limit"}
    if depth>maxDepth && bad==""{bad="depth-limit"}
    if bad=="" && !optionalNodeSpanValid(src,n){bad="invalid-source-span"}

    if s,ok:=n.(*syntax.Stmt);ok{
      fact,code,present:=stmtFact(src,s)
      if present{
        if code!=""{if bad==""{bad=code}}else{res.HeredocStatements=append(res.HeredocStatements,fact)}
      }
    }

    if c,ok:=n.(*syntax.CallExpr);ok && len(c.Args)>0{
      cmdValue,static:=staticWord(c.Args[0])
      if !static{
        ws,we,ok:=spanOK(src,c.Args[0].Pos(),c.Args[0].End());if !ok{bad="invalid-source-span";return true}
        res.UnsupportedCommands=append(res.UnsupportedCommands,UnsupportedCommand{Start:ws,End:we,Source:string(src[ws:we]),Reason:"dynamic-or-unsupported-word"})
        return true
      }
      if cmdValue=="node"{
        cs,ce,ok:=spanOK(src,c.Pos(),c.End());if !ok{bad="invalid-source-span";return true}
        ws,we,ok:=spanOK(src,c.Args[0].Pos(),c.Args[0].End());if !ok{bad="invalid-source-span";return true}
        row:=Call{Start:cs,End:ce,Command:Span{Start:ws,End:we},CommandValue:"node",FirstArgPresent:false,FirstArg:Span{Start:0,End:0},FirstArgSource:"",ExactQuotedParam:false,ParamName:""}
        if len(c.Args)>1{
          as,ae,ok:=spanOK(src,c.Args[1].Pos(),c.Args[1].End());if !ok{bad="invalid-source-span";return true}
          row.FirstArgPresent=true;row.FirstArg=Span{Start:as,End:ae};row.FirstArgSource=string(src[as:ae])
          row.ExactQuotedParam,row.ParamName=exactQuotedParam(c.Args[1])
        }
        res.Calls=append(res.Calls,row)
      }
    }

    if r,ok:=n.(*syntax.Redirect);ok && (r.Op==syntax.Hdoc || r.Op==syntax.DashHdoc){
      h,code:=buildHdoc(src,r)
      if code!=""{if bad==""{bad=code}}else{res.Heredocs=append(res.Heredocs,h)}
    }
    return true
  })
  if bad!=""{fail(src,bad,bad)}
  if res.Stats.Nodes>maxNodes{fail(src,"node-limit","AST exceeds 200000 nodes")}
  if res.Stats.MaxDepth>maxDepth{fail(src,"depth-limit","AST exceeds depth 256")}
  if err:=json.NewEncoder(os.Stdout).Encode(res);err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(3)}
}
