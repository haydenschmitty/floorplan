from fastapi import FastAPI, Depends

app = FastAPI()

def metrics_guard():
    return True

def metrics_logger():
    return True

@app.post("/billing/protected", dependencies=[Depends(metrics_guard)])
def protected():
    return {"ok": True}

@app.post("/billing/open", dependencies=[Depends(metrics_logger)])
def open_route():
    return {"ok": True}
