---
title: 온프레미스 GPU 시스템으로 교체 목표하기 - 1편
description: 클라우드 GPU 비용을 줄이기 위해 로컬 PoC와 개발 서버 AI Platform 구축을 거쳐 온프레미스 GPU로 전환하고, GPU 코어가 진짜 병목임을 확인한 기록입니다.
pubDatetime: 2026-02-20T00:00:00Z
tags:
  - AI
---

## 개요

### AI 비용을 줄이고 싶다.

2분기부터 AI 기능 관련 업무를 맡게 된다. 그 전에 선제적으로 AI 사용 비용을 줄이는 방안을 검토할 예정이다.

현재 Azure ML을 사용하고 있지만, 가용성과 효율성 측면에서 부족한 부분이 있어 온프레미스 환경의 GPU 시스템으로 교체하는 것을 목표로 잡았다.

아는 만큼 보인다고 했다. AI 모델이 어떻게 실행되는지, 어떤 세팅이 필요한지 먼저 직접 경험해보기 위해 로컬 GPU에서 PoC를 진행하고, 이후 개발 서버에 AI Platform을 구축했다.

## 안건 1 : GPU 환경 이해하기

### 문제 : GPU 기반 AI 서빙 경험이 없다

온프레미스로 전환하려면 AI 모델이 GPU에서 어떻게 실행되는지, 컨테이너화와 K8s 연동은 어떻게 하는지 직접 경험해봐야 한다. 경험 없이 설계하면 놓치는 부분이 생긴다.

### 해결 : 로컬 GPU에서 PoC 진행

Windows 환경에서 WSL2를 사용해 GPU 기반 AI 모델 서버를 Docker로 띄우고, Kubernetes(Minikube)까지 연동해보았다. 환경은 다음과 같다.

- OS: Windows 11 + WSL2 Ubuntu 24.04
- GPU: NVIDIA GeForce RTX 5060 Ti (16GB VRAM)
- Driver: 576.88 / CUDA: 12.9

#### 프로젝트 구조

```
~/model-server/
├── app.py           # FastAPI 서버
├── requirements.txt # 의존성
└── Dockerfile       # 컨테이너 빌드
```

FastAPI로 이미지 분류 API를 작성했다. ResNet18 모델을 로드하고 이미지를 받아 Top-5 예측 결과를 반환하는 구조다.

```python
from fastapi import FastAPI, UploadFile, File
from PIL import Image
import torch
import torchvision.transforms as transforms
import torchvision.models as models
import io
import urllib.request

app = FastAPI()

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {device}")

model = models.resnet18(weights=models.ResNet18_Weights.DEFAULT)
model.to(device)
model.eval()

transform = transforms.Compose([
    transforms.Resize(256),
    transforms.CenterCrop(224),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    image_bytes = await file.read()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    input_tensor = transform(image).unsqueeze(0).to(device)

    with torch.no_grad():
        outputs = model(input_tensor)
        probs = torch.nn.functional.softmax(outputs[0], dim=0)

    top5_prob, top5_idx = torch.topk(probs, 5)
    results = [{"label": labels[i], "prob": float(p)} for p, i in zip(top5_prob, top5_idx)]

    return {"predictions": results}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

`torch.device`는 CUDA가 사용 가능하면 GPU를, 아니면 CPU를 사용하도록 장치를 선택한다.

```
torch.device("cuda" if torch.cuda.is_available() else "cpu")
```

모델이 추론을 수행할 때 CPU와 GPU는 각각 다른 역할을 담당하며, 데이터는 RAM과 VRAM 사이를 오간다.

![CPU와 GPU 사이에서 RAM과 VRAM을 오가는 추론 데이터 흐름 다이어그램](/posts/on-premise-gpu-migration-part-1/fig-01.png)

1. CPU가 RAM에서 이미지를 전처리한다. 텐서로 변환하는 과정이다.
2. 전처리된 텐서를 RAM에서 VRAM으로 복사한다.
3. GPU가 VRAM에 있는 데이터로 벡터 연산을 수행한다.
4. 연산 결과를 VRAM에서 RAM으로 복사한다.

> 이 때, RAM과 VRAM 은 PCIe 버스를 통해 전송된다.

서버가 시작될 때 세팅 초기화도 순서가 있다.

1. 연결할 장치를 찾는다.
2. 모델을 로드한다.
3. 모델에 장치를 연결한다.

#### GPU가 AI 연산에 적합한 이유

CPU는 제어 장치, 연산 장치, 레지스터로 구성되며, Fetch -> Decode -> Execute -> Store 사이클을 반복한다. 반면 GPU는 제어 장치를 최소화하고 그 공간을 연산 장치로 채웠다. NVIDIA GPU 기준으로 이 작은 연산 장치 하나를 CUDA Core라고 부르며, 최신 GPU에는 수천 개가 들어 있다.

GPU 연산의 전체 흐름은 다음과 같다.

1. CPU가 데이터를 RAM에서 GPU의 VRAM으로 복사한다.
2. CPU가 GPU에 커널(실행할 함수)을 전달한다.
3. 각 SM에서 CUDA Core들이 데이터를 레지스터에 올리고 연산을 수행한다.
4. 연산 결과가 VRAM에 저장된다.
5. CPU가 결과를 VRAM에서 RAM으로 복사해온다.

> CPU와 GPU 사이에 데이터 복사가 발생하는 것이 핵심이다. 이 복사는 PCIe 버스를 통해 이루어지며, 연산 자체보다 이 전송이 병목이 되는 경우도 있다.

### 결과 :

#### 효과적이다.

- GPU 연산 흐름(CPU↔GPU 데이터 전송, PCIe 버스)을 직접 체득했다.
- Docker 컨테이너에서 GPU를 사용하는 방법과 K8s GPU 할당 방식을 경험했다.
- K8s에서 GPU는 파드당 하나씩 할당되며, GPU 수보다 많은 파드는 Pending 상태가 되는 것을 확인했다.

#### 효과적이지 않다.

RTX 50 시리즈와 Minikube에서 예상치 못한 이슈를 경험했다.

**트러블슈팅 1 : RTX 50 시리즈 PyTorch 미지원**

처음에는 아래와 같이 Dockerfile을 작성했다.

```dockerfile
FROM nvidia/cuda:12.6.1-runtime-ubuntu24.04
RUN pip3 install torch==2.2.0 torchvision==0.17.0
```

실행하자 다음과 같은 에러가 발생했다.

```
NVIDIA GeForce RTX 5060 Ti with CUDA capability sm_120 is not compatible
with the current PyTorch installation.
The current PyTorch install supports CUDA capabilities sm_50 sm_60 sm_70 sm_75 sm_80 sm_86 sm_90.
```

RTX 50 시리즈는 Blackwell 아키텍처 기반으로 sm_120을 사용하는데, PyTorch stable 버전은 sm_90까지만 지원하고 있었다. PyTorch nightly 버전으로 전환하여 문제를 해결했다.

```dockerfile
FROM nvidia/cuda:12.8.0-runtime-ubuntu24.04

WORKDIR /app

...

# PyTorch nightly (sm_120 지원)
RUN pip3 install --no-cache-dir --break-system-packages \
    --pre torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/nightly/cu128

RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

...

CMD ["python3", "app.py"]
```

**트러블슈팅 2 : Minikube에서 GPU 인식 안 됨**

Minikube에서 Docker에 연결된 GPU를 모두 사용할 수 있도록 설정했지만, 정상적으로 인식되지 않았다.

```bash
minikube start --driver=docker --gpus all
```

```bash
kubectl describe nodes | grep nvidia
# 아무것도 안 나옴
```

NVIDIA device plugin 로그를 확인해보니 다음과 같았다.

```
Failed to initialize NVML: Not Supported.
If this is a GPU node, did you set the docker default runtime to `nvidia`?
```

원인은 WSL2의 GPU 접근 방식에 있었다. WSL2는 `/dev/nvidia*` 대신 `/dev/dxg`를 통해 GPU에 접근하기 때문에, Minikube 컨테이너가 WSL의 GPU 라이브러리에 접근할 수 있도록 마운트가 필요했다.

```bash
minikube delete

minikube start \
    --driver=docker \
    --gpus=all \
    --mount --mount-string="/usr/lib/wsl:/usr/lib/wsl"
```

마운트 이후 GPU가 정상적으로 인식되는 것을 확인했다.

```bash
kubectl describe nodes | grep nvidia
# nvidia.com/gpu: 1
```

## 안건 2 : 개발 서버에 AI Platform 구축하기

### 문제 : 클라우드 GPU 과금 비용 + 온디바이스 성능 한계

클라우드 GPU로 인해 발생하는 과금 비용이 트래픽에 비례하여 증가하고 있었다. 온디바이스(CPU) 모델은 처리 속도가 느려 사용자 경험이 좋지 않았다.

### 원인 : 클라우드 종량제 구조

클라우드 GPU은 트래픽이 늘어나면 비용도 비례하여 증가하는 구조다.

### 해결 : 유휴 장비 확보 + 온프레미스 전환

클라우드 GPU로 인해 발생하는 과금 비용을 개선하기 위해 온프레미스 GPU 인프라로 전환했다.

#### 인프라 유휴 장비 찾으러 다니기

| 항목                       | 내용                                               |
| -------------------------- | -------------------------------------------------- |
| 소수의 유휴 장비 무상 확보 | 사내 유휴 장비 요청                                |
| 소수의 유휴 장비 무상 확보 | 노후된 RTX 3080 / RTX 3090 (고장 시 교체하며 운영) |

별도 예산 없이 유휴 자원을 발굴하여 초기 투자 비용 0원으로 전환했다.

#### 아키텍처 설계

![온프레미스 AI Platform 아키텍처: 클라이언트 요청이 Rate Limiter를 거쳐 FastAPI 기반 GPU 서버로 전달되는 구조](/posts/on-premise-gpu-migration-part-1/fig-02.png)

클라이언트에서 `{domain}.co.kr` 로 요청이 들어오면, Rate Limiter를 거쳐 FastAPI 기반 AI Platform으로 전달된다. AI 배경제거, 화질개선, 지우개, 모자이크 기능이 서버 장비의 GPU에서 처리되며, GPU 대수에 맞게 스케일아웃하는 구조다.

#### 모델별 전환 성과

**클라우드 GPU → 온프레미스 GPU 전환**

화질개선 기능을 클라우드 GPU 활용 방식에서 온프레미스 GPU 활용 방식으로 전환했다. 이 때, 단건 처리에서 최대 동시 요청을 조절할 수 있도록 개선했다.

| 지표          | As-Is | To-Be | 개선율        |
| ------------- | ----- | ----- | ------------- |
| Mean TPS      | 5s    | 3s    | **40% 개선**  |
| 메모리 사용률 | 8%    | 36%   | **24%p 개선** |

화질 개선 예시는 다음과 같다.

![화질개선 기능 적용 전후 비교 예시 이미지](/posts/on-premise-gpu-migration-part-1/fig-03.jpg)

**온디바이스 CPU → 온프레미스 GPU 전환**

CPU에서 GPU로 전환하면서 추론 속도를 개선했다.

| 기능         | As-Is | To-Be | 개선율       |
| ------------ | ----- | ----- | ------------ |
| 배경제거     | 3.5s  | 0.5s  | **85% 개선** |
| 얼굴모자이크 | 1.0s  | 0.1s  | **90% 개선** |
| 지우개       | 3.5s  | 0.6s  | **82% 개선** |

배경제거 기능 예시는 다음과 같다.

![배경제거 기능 적용 전후 비교 예시 이미지](/posts/on-premise-gpu-migration-part-1/fig-04.jpg)

### 트러블슈팅 1 : GFPGAN 동시 실행 시 메모리 충돌

화질개선 기능은 두 개 이상 동시 실행 시 메모리 충돌 문제가 발생했다. 화질개선에서 사용하는 GFPGAN 모델은 내부에 mutable state(`face_helper.input_img`, `cropped_faces`, `restored_faces` 등 7개 인스턴스 변수)를 보유하고 있어, 동시 접근 시 상태 충돌이 발생했다.

| 구성         | 인스턴스 수 | 동시 접근 | 결과                     |
| ------------ | :---------: | :-------: | ------------------------ |
| Semaphore(1) |     1개     |    1개    | 100% 성공 (순차 처리)    |
| Semaphore(2) |     1개     |  **2개**  | **HTTP 500** (상태 충돌) |

독립 인스턴스 N개를 생성하며 상태 충돌 없이 처리하도록 SessionPool을 구현했다.

```python
class SessionPool:
    def __init__(self, factory_fn, pool_size):
        self._pool = asyncio.Queue(maxsize=pool_size)
        for _ in range(pool_size):
            self._pool.put_nowait(factory_fn())  # N개 독립 인스턴스 생성

    @asynccontextmanager
    async def acquire(self):
        session = await self._pool.get()  # 대기열에서 슬롯 획득
        try:
            yield session
        finally:
            self._pool.put_nowait(session)  # 사용 후 반환
```

| 구성           | 인스턴스 수 | 동시 접근 | 결과                      |
| -------------- | :---------: | :-------: | ------------------------- |
| SessionPool(2) |   **2개**   |    2개    | 100% 성공 (독립 인스턴스) |
| SessionPool(3) |   **3개**   |    3개    | 100% 성공                 |
| SessionPool(4) |   **4개**   |    4개    | 100% 성공                 |

> SessionPool 전환 후 HTTP 500 (상태 충돌)이 완전히 해결됐다.

### 트러블슈팅 2 : 운영 환경 부하 테스트

GPU 운영 관점에서 어떻게 부하 테스트할지 고민됐다. 로컬 환경에서 RTX 4090, timeout=30s, 화질개선 SessionPool(4) 기준으로 측정했다.

#### API별 독립 테스트 (1,000 요청/엔드포인트, 200 Iterations)

| 엔드포인트         | 동시성 모델    | Mean  | P95   | 성공률 | 처리량    |
| ------------------ | -------------- | ----- | ----- | ------ | --------- |
| `/api/v1/remove`   | SessionPool(2) | 0.52s | 0.74s | 100%   | 6.88 rps  |
| `/api/v1/faceblur` | SessionPool(2) | 0.09s | 0.11s | 100%   | 48.05 rps |
| `/api/v1/segment`  | SessionPool(2) | 0.42s | 0.60s | 100%   | 9.16 rps  |
| `/api/v1/inpaint`  | SessionPool(2) | 0.63s | 0.70s | 100%   | 7.39 rps  |
| `/api/v1/restore`  | Semaphore(1)   | 2.85s | 4.56s | 100%   | 1.11 rps  |

> 순차적으로 5,000건 요청했을 때, 실패는 0건이고, Mean/P95 변화 없이 안정적으로 수렴했다. 장시간 운영에서도 throttling 등 성능 저하가 없음을 확인했다.

#### 전 엔드포인트 동시 요청 테스트

실제 운영 환경처럼 모든 엔드포인트에 동시에 요청을 보내어 GPU 경합 상황에서의 성능을 측정했다.

| 지표           |  5 rps   |  10 rps  |  15 rps   |  20 rps   |
| -------------- | :------: | :------: | :-------: | :-------: |
| 전체 성공률    | **100%** | **100%** |   90.1%   |   84.2%   |
| 실제 처리량    | 4.0 rps  | 4.0 rps  |  4.2 rps  |  4.1 rps  |
| restore 성공률 |   100%   |   100%   | **50.6%** | **20.8%** |
| 최대 동시 대기 |   23건   |  115건   |   355건   |   645건   |

- GPU 1장의 물리적 한계로 인해 서버 처리 능력은 부하와 무관하게 **~4 rps로 수렴**하는 특징을 확인했다.
- 15 rps부터 restore 엔드포인트에서 타임아웃 실패가 발생했다. restore는 Semaphore(1)로 최대 1.1 rps만 처리 가능하기 때문이다.

### 트러블슈팅 3 : SessionPool 스케일링 최적점 탐색

GPU의 병목 지점이 VRAM인지, GPU 코어인지 확인하기 위해 화질개선 SessionPool을 2에서 6까지 단계적으로 확장하며 성능 변화를 측정했다.

#### 5 rps restore Mean 추이

| 화질개선 SessionPool Size | restore Mean |  이전 대비 변화   | 비고          |
| :-----------------------: | :----------: | :---------------: | ------------- |
|          Pool(2)          |    9.41s     |       기준        |               |
|          Pool(3)          |    8.34s     | **-1.07s (-11%)** | 개선          |
|          Pool(4)          |  **7.45s**   | **-0.89s (-11%)** | **최적점**    |
|          Pool(5)          |    10.35s    |   +2.90s (+39%)   | GPU 경합 악화 |
|          Pool(6)          |    8.05s     |   -2.30s (-22%)   | 반등 (변동성) |

Pool(4)까지 꾸준히 개선되다가 Pool(5)에서 오히려 10.35s로 급등하며 **GPU core contention**이 발생함을 경험했다.

#### VRAM vs GPU 코어

GFPGAN 인스턴스 1개당 VRAM 약 520MB 추가됐다. RTX 4090 (24GB)에서 Pool(6)까지도 피크 12.5GB로 OOM 위험은 없었다. **VRAM은 여유롭지만 GPU 코어가 병목이었다.**

| 구성           | Idle VRAM | 피크 VRAM | 메모리 추가 비용 |
| -------------- | :-------: | :-------: | :--------------: |
| SessionPool(2) | 2,774 MB  | 9,421 MB  |       기준       |
| SessionPool(3) | 3,293 MB  | 10,349 MB |     +519 MB      |
| SessionPool(4) | 3,812 MB  | 10,933 MB |     +519 MB      |
| SessionPool(5) | 4,329 MB  | 11,233 MB |     +520 MB      |
| SessionPool(6) | 4,848 MB  | 12,489 MB |     +520 MB      |

#### 운영 타임아웃 30s 적용 시 SLA 한계

Pool당 520MB VRAM을 추가 투자해도 10 rps에서 restore 성공률 개선은 0.8~0.9%p에 불과했다. **30초 타임아웃 기준으로 5 rps (전체) = 엔드포인트당 1 rps가 현재 인프라의 실질적인 SLA 한계**라는 결론을 내렸다.

| RPS | Pool(2)  | Pool(3)  | Pool(4)  | Pool(5)  | Pool(6)  |
| :-: | :------: | :------: | :------: | :------: | :------: |
|  5  | **100%** | **100%** | **100%** | **100%** | **100%** |
| 10  |  10.8%   |  10.8%   |  11.7%   |  12.5%   |  13.3%   |

### Feature Flag 기반 선택적 로딩

화질개선 기능은 평균 처리 시간이 3s이기 때문에 격리해서 관리할지 여부를 판단해야 했다. 유연하게 운영하기 위해 환경변수로 모델별 활성화 여부를 제어하는 Feature Flag를 구축했다.

```python
ENABLE_REMOVER  = os.getenv("ENABLE_REMOVER", "true").lower() == "true"
ENABLE_FACEBLUR = os.getenv("ENABLE_FACEBLUR", "true").lower() == "true"
ENABLE_ERASER   = os.getenv("ENABLE_ERASER", "true").lower() == "true"
ENABLE_RESTORE  = os.getenv("ENABLE_RESTORE", "true").lower() == "true"
```

### 섀도잉 전략으로 운영 환경 검증

실제 프로덕션 트래픽을 온프레미스 시스템에 미러링하여 운영 가능성을 검증했다.

![섀도잉 전략 다이어그램: API Gateway에서 실제 요청은 클라우드 GPU로, Shadow 요청은 온프레미스로 전달](/posts/on-premise-gpu-migration-part-1/fig-05.png)

API Gateway에서 실제 요청은 클라우드 GPU로, Shadow 요청은 온프레미스로 fire & forget 방식으로 전달한다. 프로덕션에 영향 없이 온프레미스 시스템의 안정성을 검증할 수 있었다.

### 결과 :

#### 효과적이다.

- 별도 예산 없이 유휴 자원을 발굴하여 **초기 투자 비용 0원**으로 전환했다.
- 트래픽 증가율 10배를 목표 기준으로 **월 약 92% 절감**할 수 있다.
- 전 기능 **성능 40~90% 개선**을 달성했다.
- SessionPool 스케일링 테스트를 통해 **데이터 기반 운영 기준**(Pool 크기, SLA, 타임아웃)을 확보했다.
- 섀도잉 전략으로 프로덕션에 영향 없이 **운영 가능성을 사전 검증**했다.

#### 효과적이지 않다.

- GPU 1장의 물리적 한계로 전체 처리량이 ~4 rps에 수렴한다. restore 단독으로는 0.6 rps가 한계다.
- SessionPool 확장만으로는 고부하 대응이 불가능하다. Pool(5) 이상에서는 GPU 코어 경합으로 오히려 성능이 악화된다.
- 노후된 RTX 3080/3090을 사용하므로 고장 시 교체하며 운영해야 하는 리스크가 있다.

## 마무리

### GPU 메모리가 아니라 GPU 코어가 병목이었다.

처음 로컬에서 PoC를 진행할 때, K8s에서 GPU 메모리 활용률이 낮은 것이 눈에 들어왔다.

> 12GB GPU에서 모델 하나만 실행될 때 실제로는 2GB만 사용한다면 10GB의 유휴 자원이 발생한다.

메모리 유휴 상태를 해결하면 성능 이점이 있을 것이라 생각했다. NVIDIA vGPU 같은 가상 GPU 기술로 메모리를 분할해 활용하는 방안도 검토했다.

그러나 SessionPool 스케일링 테스트를 통해 실제 병목은 VRAM이 아니라 **GPU 코어**임을 확인했다.

| Pool Size |   Idle VRAM    |   restore Mean    | 비고                           |
| :-------: | :------------: | :---------------: | ------------------------------ |
|  Pool(4)  | 3,812 MB (16%) |     **7.45s**     | 최적점. VRAM 여유 20GB         |
|  Pool(5)  | 4,329 MB (18%) | **10.35s (+39%)** | VRAM 여유 19.7GB인데 성능 급락 |

Pool(4)에서 Pool(5)로 전환했을 때 VRAM은 520MB(2%)만 추가됐지만, 응답시간은 39% 급등했다. VRAM은 충분히 여유로운데 GPU 코어에서 경합이 발생한 것이다. 메모리 사용률을 높이는 것은 큰 도움이 되지 않았다.

오히려 효과적이었던 것은 **다수 인스턴스를 분산 배치하여 레이턴시를 평탄화**하는 것이었다. Semaphore(1)에서 SessionPool(4)로 전환하면서 restore Mean이 12.64s → 7.45s로 **41% 개선**됐다. GPU 코어를 적절히 나눠쓰는 수준까지 인스턴스를 늘리되, 경합이 발생하기 전에 멈추는 것이 핵심이었다.

### 앞으로 하고 싶은 것

현재 GPU 1장의 한계(~4 rps, restore 0.6 rps)가 명확하다. 다음 단계로는 멀티 서버에 요청을 균등하게 분산하고 비동기로 처리하는 구조를 만들고 싶다. 복잡한 큐 분리 전략보다는, 심플하게 여러 서버에 고르게 나누고 각 서버가 독립적으로 처리하는 방향을 목표로 한다.
