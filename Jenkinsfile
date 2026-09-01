pipeline {
  agent any

  environment {
    APP_NAME = 'button-push-site'
    IMAGE_NAME = 'button-push-site'
    APP_PORT = '3000'
  }

  stages {
    stage('Install') {
      steps {
        sh 'npm ci'
      }
    }

    stage('Test') {
      steps {
        sh 'npm test'
      }
    }

    stage('Build Docker Image') {
      steps {
        sh 'docker build -t ${IMAGE_NAME}:${BUILD_NUMBER} -t ${IMAGE_NAME}:latest .'
      }
    }

    stage('Deploy On Jenkins Host') {
      when {
        allOf {
          branch 'main'
          environment name: 'DEPLOY_ON_JENKINS_HOST', value: 'true'
        }
      }
      steps {
        sh '''
          docker rm -f ${APP_NAME} || true
          docker run -d \
            --restart unless-stopped \
            --name ${APP_NAME} \
            -p ${APP_PORT}:3000 \
            -e ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
            ${IMAGE_NAME}:${BUILD_NUMBER}
        '''
      }
    }
  }
}
