# 버튼 푸쉬 사이트

컴퓨터실 강의에서 학생들의 작업 완료 여부를 실시간으로 확인하는 웹 앱입니다.

## 기능

- 접속 중인 사용자 수 표시
- 운영자 로그인 세션은 접속자 수와 목록에서 제외
- 사용자 닉네임 입장 및 접속 목록 표시
- 실시간 채팅
- 운영자 전용 푸쉬버튼
- 푸쉬 진행 중 미완료 사용자는 빨간색, 완료 사용자는 초록색 표시
- 모든 사용자가 누르면 운영자에게 완료 창 표시
- 운영자가 `OK`를 누르면 푸쉬 상태 초기화

## 로컬 실행

```powershell
npm install
$env:ADMIN_PASSWORD="원하는_비밀번호"
npm start
```

브라우저에서 `http://localhost:3000`으로 접속합니다.

기본 운영자 비밀번호는 `admin1234`입니다. 실제 사용 시 반드시 `ADMIN_PASSWORD` 환경 변수로 변경하세요.

## Docker 실행

```powershell
$env:ADMIN_PASSWORD="원하는_비밀번호"
docker compose up -d --build
```

## GitHub 업로드

GitHub에서 빈 저장소를 만든 뒤 아래 명령을 실행합니다.

```powershell
git init
git add .
git commit -m "Initial classroom button push site"
git branch -M main
git remote add origin https://github.com/<GitHub아이디>/<저장소이름>.git
git push -u origin main
```

현재 작업 환경에는 GitHub 저장소를 자동 생성할 수 있는 `gh` CLI나 GitHub 커넥터가 없어 원격 저장소 생성은 직접 한 번 필요합니다.

## Jenkins 설정

1. Jenkins에서 Pipeline 프로젝트를 생성합니다.
2. GitHub 저장소 URL을 SCM으로 연결합니다.
3. Script Path는 `Jenkinsfile`로 둡니다.
4. Jenkins 환경 변수 또는 Credentials로 `ADMIN_PASSWORD`를 설정합니다.
5. Jenkins 서버에서 Docker로 바로 실행하려면 `DEPLOY_ON_JENKINS_HOST=true`를 설정합니다.

`DEPLOY_ON_JENKINS_HOST`를 켜지 않으면 Jenkins는 설치, 테스트, Docker 이미지 빌드까지만 수행합니다.

## 운영 방식

학생은 닉네임으로 입장합니다. 운영자는 운영자 비밀번호로 로그인합니다.

운영자가 `푸쉬버튼`을 누르면 접속 목록이 진행 상태 색상으로 바뀌고, 학생 화면에는 완료 버튼이 표시됩니다. 학생이 버튼을 누르면 해당 학생은 초록색으로 바뀝니다. 모두 완료되면 운영자에게 완료 창이 뜨며, `OK`를 누르면 색상이 초기화됩니다.
